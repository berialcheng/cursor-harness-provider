import { checkRustWorkspace, runCargo } from "./rust-env.mjs";
checkRustWorkspace();
runCargo(["fmt", "--all", "--", "--check"]);
runCargo(["clippy", "--workspace", "--all-targets", "--locked", "--", "-D", "warnings"]);
