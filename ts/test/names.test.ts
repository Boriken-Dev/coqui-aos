import { normalizeName, rootVariable, validOverlayName } from "../src/names.ts";
import { obj, runFile, str } from "./support.ts";

runFile("names.json", (item) => {
  const name = str(item.get("name"));
  const expect = obj(item.get("expect"));
  const valid = validOverlayName(name);
  if (expect.get("valid") !== valid) throw new Error(`valid ${valid}`);
  if (valid && (expect.get("normalized") !== normalizeName(name) || expect.get("variable") !== rootVariable(name))) {
    throw new Error(`${normalizeName(name)} ${rootVariable(name)}`);
  }
});
