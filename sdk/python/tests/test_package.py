from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10
    import tomli as tomllib


def test_publishable_manifest():
    root = Path(__file__).resolve().parents[1]
    project = tomllib.loads((root / "pyproject.toml").read_text())["project"]
    assert project["name"] == "singit"
    assert project["version"] == "0.1.0"
    assert not any(c.startswith("Private ::") for c in project["classifiers"])
    assert project["readme"] == "README.md"
    assert project["license-files"] == ["LICENSE"]
