"""Local shortcut: python dashboard/build_day.py YYYY-MM-DD  -> runs pipeline/build_day.py"""
import os, runpy, sys
runpy.run_path(os.path.join(os.path.dirname(os.path.abspath(__file__)), "pipeline", "build_day.py"), run_name="__main__")
