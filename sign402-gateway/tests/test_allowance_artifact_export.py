"""The standalone code verifier must reject the same forged immutable copies."""

import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "allowance_export", ROOT / "agent-allowance/script/export_artifact.py"
)
export = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(export)


class ExportRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.artifact = json.loads(export.TARGET.read_text())

    def test_both_independent_artifacts_have_identical_complete_groups(self):
        self.assertEqual(self.artifact, json.loads(export.SIDECAR_TARGET.read_text()))
        flat = sorted(ref for group in self.artifact["immutableGroups"] for ref in group)
        self.assertEqual(flat, self.artifact["immutableRanges"])
        self.assertEqual(len(flat), len({tuple(ref) for ref in flat}))
        size = len(bytes.fromhex(self.artifact["deployedBytecode"][2:]))
        self.assertTrue(all(0 <= start and length == 32 and start + length <= size
                            for start, length in flat))

    def test_every_split_immutable_is_rejected_by_the_standalone_check(self):
        for group in self.artifact["immutableGroups"]:
            for start, length in group:
                with self.subTest(start=start):
                    code = bytearray.fromhex(self.artifact["deployedBytecode"][2:])
                    code[start:start + length] = (123).to_bytes(length, "big")
                    self.assertFalse(export.matches_runtime("0x" + code.hex(), self.artifact))

    def test_valid_deployment_parameters_and_bad_lengths(self):
        code = bytearray.fromhex(self.artifact["deployedBytecode"][2:])
        for index, group in enumerate(self.artifact["immutableGroups"], 1):
            for start, length in group:
                code[start:start + length] = index.to_bytes(length, "big")
        self.assertTrue(export.matches_runtime("0x" + code.hex(), self.artifact))
        for malformed in ("0x", "0xno", "0x" + code[:-1].hex(), "0x" + code.hex() + "00"):
            self.assertFalse(export.matches_runtime(malformed, self.artifact))
