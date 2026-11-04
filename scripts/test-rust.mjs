import { checkRustWorkspace, runCargo } from "./rust-env.mjs";
checkRustWorkspace();
runCargo(["test", "--workspace", "--locked", ...process.argv.slice(2)]);
