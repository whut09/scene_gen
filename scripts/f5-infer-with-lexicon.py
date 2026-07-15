import argparse
import runpy
import sys
from tts_pronunciation import load_pronunciation_lexicon


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--lexicon", required=True)
    known, remaining = parser.parse_known_args()
    load_pronunciation_lexicon(known.lexicon)
    sys.argv = ["f5_tts.infer.infer_cli", *remaining]
    runpy.run_module("f5_tts.infer.infer_cli", run_name="__main__")


if __name__ == "__main__":
    main()
