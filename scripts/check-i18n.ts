import en from "../messages/en.json" with { type: "json" };
import bn from "../messages/bn.json" with { type: "json" };
import { compareMessages } from "../src/i18n/check-messages";

const problems = compareMessages(en, bn);
if (problems.length) {
  console.error(`Translation files are out of sync:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("en.json and bn.json have the same keys.");
