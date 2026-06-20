"""spike1_runner.py — load a generated Langflow custom component, run it, report convergence.
usage: /tmp/lf-venv/bin/python spike1_runner.py <component_file.py>
exit 0 = CONVERGED (imports + instantiates per installed Langflow API + output method runs without error)
exit 1 = error (full traceback to stderr → fed back into the repair loop)
ponytail: throwaway spike harness. invokes the component standalone (hardcoded-target, no inputs)."""
import sys, importlib.util, traceback, inspect

path = sys.argv[1]
try:
    from langflow.custom import Component
except Exception:
    print("FATAL: cannot import langflow.custom.Component", file=sys.stderr)
    traceback.print_exc(); sys.exit(2)

spec = importlib.util.spec_from_file_location("gen_comp", path)
mod = importlib.util.module_from_spec(spec)
sys.modules["gen_comp"] = mod                                      # langflow Component.__init__ → set_class_code() → inspect.getfile(cls) needs the module registered
try:
    spec.loader.exec_module(mod)                                   # import error → ② API drift / ③ missing dep surfaces here
    cls = next(o for _, o in inspect.getmembers(mod, inspect.isclass)
               if issubclass(o, Component) and o is not Component and o.__module__ == "gen_comp")
    comp = cls()                                                   # instantiation per the installed Component API
    if not getattr(comp, "outputs", None):
        raise RuntimeError("component declares no outputs[]")
    method = comp.outputs[0].method                                # the output/build method name
    out = getattr(comp, method)()                                  # runs the real external call → ④ endpoint/shape hallucination surfaces here
    print("OK:", type(out).__name__, "|", repr(getattr(out, "text", out))[:240])
    sys.exit(0)
except Exception:
    traceback.print_exc(); sys.exit(1)
