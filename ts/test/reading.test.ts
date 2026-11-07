import { readDotenv } from "../src/apply.ts";
import { readCatalogDocument } from "../src/catalog.ts";
import { Environment } from "../src/environment.ts";
import { readDocument, readEnvScriptOutput } from "../src/read.ts";
import { stringMap } from "./env_support.ts";
import { bytesOf, compare, runFile, settingsOf, str, strings } from "./support.ts";

runFile("reading.json", (item) => {
  const data = bytesOf(item);
  const settings = settingsOf(item);
  const format = str(item.get("format"));
  if (format === "aos") {
    compare(() => readDocument(data, settings), item.get("expect"));
  } else if (format === "env-script") {
    compare(() => new Map(readEnvScriptOutput(data, settings).map(([name, value]) => [name, value ?? null])), item.get("expect"));
  } else if (format === "dotenv") {
    const env = new Environment(stringMap(item.get("env")), item.get("os") === "windows");
    for (const name of strings(item.get("secret_variables"))) env.set(name, env.get(name) ?? "", true);
    compare(() => new Map(readDotenv(data, env)), item.get("expect"));
  } else if (format === "catalog") {
    compare(() => readCatalogDocument(data, str(item.get("name")), settings), item.get("expect"));
  } else {
    throw new Error(`format ${format}`);
  }
});
