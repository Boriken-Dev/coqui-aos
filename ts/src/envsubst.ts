/** The `envsubst` renderer of the knowledge section, behind one function so another implementation can replace it. */
import { template } from "./template.ts";

/** `text` with each `${NAME}` whose name `values` holds replaced; every other text is itself. */
export function envsubst(text: string, values: ReadonlyMap<string, string>): string {
  return template(text, values);
}
