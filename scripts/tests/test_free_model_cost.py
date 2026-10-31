import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "free-model-cost.py"
SNAPSHOT = ROOT / "docs" / "data" / "singit-models-2026-10-24.json"


def load_script():
    spec = importlib.util.spec_from_file_location("free_model_cost", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


fmc = load_script()

MODELS = {
    "data": [
        {"id": "cheap", "usdPerMillionTokens": {"input": 0.5, "output": 2},
         "expectedUsdPerMillionTokens": {"input": 0.1, "output": 0.4, "basis": "trusted"}},
        {"id": "listed-only", "usdPerMillionTokens": {"input": 1, "output": 1}},
        {"id": "no-price"},
    ]
}


def write(directory, document):
    path = Path(directory) / "models.json"
    path.write_text(json.dumps(document), encoding="utf-8")
    return path


class AnswerCostTests(unittest.TestCase):
    def test_worst_case_uses_dense_text_and_framing_plus_max_output_tokens(self):
        # 4004 input tokens and 400 output tokens at $2/M input, $10/M output.
        cost = fmc.answer_cost((Decimal("2"), Decimal("10")), 4000, 400)
        self.assertEqual(cost, Decimal("0.012008"))

    def test_no_price_is_no_number(self):
        self.assertIsNone(fmc.answer_cost(None, 4000, 400))

    def test_prices_that_are_not_numbers_are_unusable(self):
        for raw in (None, "1", {}, {"input": 1}, {"input": True, "output": 1}, {"input": -1, "output": 1},
                    {"input": "0.1", "output": 1}):
            with self.subTest(raw=raw):
                self.assertIsNone(fmc._price(raw))
        self.assertEqual(fmc._price({"input": 0, "output": 0.25}), (Decimal("0"), Decimal("0.25")))


class ReportTests(unittest.TestCase):
    def setUp(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.models = fmc.load_models(write(tmp, MODELS))

    def report(self, wanted, **kw):
        args = {"max_chars": 4000, "max_tokens": 400, "caps": [100, 1000], "days": 30, **kw}
        return fmc.report(self.models, wanted, **args)

    def test_list_and_expected_prices_and_monthly_cost_at_each_cap(self):
        row = self.report(["cheap"])[0]
        # List and expected rates use 4004 input tokens and 400 output tokens.
        self.assertEqual(row["list"]["perAnswerUsd"], Decimal("0.002802"))
        self.assertEqual(row["expected"]["perAnswerUsd"], Decimal("0.0005604"))
        self.assertEqual(row["list"]["perMonthUsd"]["100"], Decimal("0.002802") * 100 * 30)
        self.assertEqual(row["expected"]["perMonthUsd"]["1000"], Decimal("0.0005604") * 1000 * 30)
        self.assertEqual(row["expectedBasis"], "trusted")

    def test_missing_prices_and_models_are_reported_not_guessed(self):
        listed_only, no_price, absent = self.report(["listed-only", "no-price", "absent"])
        self.assertIsNone(listed_only["expected"]["perAnswerUsd"])
        self.assertIsNotNone(listed_only["list"]["perAnswerUsd"])
        self.assertIsNone(no_price["list"]["perAnswerUsd"])
        self.assertEqual(no_price["list"]["perMonthUsd"], {"100": None, "1000": None})
        self.assertFalse(absent["found"])
        self.assertIsNone(absent["list"]["perAnswerUsd"])

    def test_limits_change_the_numbers(self):
        short = self.report(["cheap"], max_chars=400, max_tokens=40)[0]
        # 404 * 0.5 + 40 * 2 = 282 / 1e6
        self.assertEqual(short["list"]["perAnswerUsd"], Decimal("0.000282"))

    def test_float_noise_in_the_file_does_not_leak_into_the_arithmetic(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = write(tmp, {"data": [{"id": "m", "usdPerMillionTokens": {"input": 0.075, "output": 0.2}}]})
            models = fmc.load_models(path)
        row = fmc.report(models, ["m"], max_chars=4000, max_tokens=400, caps=[1], days=1)[0]
        self.assertEqual(row["list"]["perAnswerUsd"], Decimal("0.0003803"))


class LoadTests(unittest.TestCase):
    def test_a_file_without_data_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            for document in ({}, [], {"data": "x"}):
                with self.assertRaises(ValueError):
                    fmc.load_models(write(tmp, document))


class CommandTests(unittest.TestCase):
    def run_main(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = fmc.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_table_output_names_each_model_and_both_prices(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, out, _ = self.run_main(str(write(tmp, MODELS)), "--models", "cheap,absent", "--caps", "100,300")
        self.assertEqual(code, 0)
        self.assertIn("LIST price", out)
        self.assertIn("EXPECTED price", out)
        self.assertIn("0.00280200", out)
        self.assertIn("0.00056040", out)
        self.assertIn("100/day/mo", out)
        self.assertIn("300/day/mo", out)
        self.assertIn("absent", out)
        self.assertIn("not in file", out)

    def test_json_output_is_parseable(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, out, _ = self.run_main(str(write(tmp, MODELS)), "--models", "cheap", "--json")
        self.assertEqual(code, 0)
        self.assertAlmostEqual(json.loads(out)[0]["list"]["perAnswerUsd"], 0.002802)

    def test_bad_input_exits_2_with_a_message(self):
        code, _, err = self.run_main("/nonexistent/models.json")
        self.assertEqual((code, err.startswith("error:")), (2, True))
        with tempfile.TemporaryDirectory() as tmp:
            code, _, err = self.run_main(str(write(tmp, {"nope": 1})))
            self.assertEqual((code, "data[]" in err), (2, True))

    def test_the_saved_snapshot_gives_the_numbers_the_proposal_quotes(self):
        code, out, _ = self.run_main(str(SNAPSHOT))
        self.assertEqual(code, 0)
        # DeepSeek list: 4004 * 0.02 + 400 * 1; 1000/day for 30 days
        self.assertIn("0.00048008", out)
        self.assertIn("14.4024", out)
        # GPT OSS list: 4004 * 0.018 + 400 * 0.09
        self.assertIn("0.00010807", out)
        for model in fmc.DEFAULT_MODELS:
            self.assertIn(model, out)


if __name__ == "__main__":
    unittest.main()
