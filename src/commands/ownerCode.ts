import kleur from "kleur";
import { extractFlag } from "../core/args.js";
import { isLocalInstanceUrl } from "../core/config.js";
import { errorMessage } from "../core/errors.js";
import {
  findOwnerEmail,
  LOCAL_AUTH_URL,
  requestOwnerCode,
  waitForAuthServer,
} from "../core/ownerCode.js";

export async function runOwnerCode(args: string[]): Promise<void> {
  const { value: urlFlag, rest } = extractFlag(args, "url");
  const json = rest.includes("--json");
  const positional = rest.filter((arg) => !arg.startsWith("-"));
  const authUrl = (urlFlag ?? LOCAL_AUTH_URL).replace(/\/+$/, "");

  try {
    // The code comes back in the response only because a local dev stack allows it.
    // Refusing anything else keeps this from reading as a way to get codes anywhere.
    if (!isLocalInstanceUrl(authUrl)) {
      throw new Error(
        `owner-code only works against a local auth server, and ${authUrl} is not one.`,
      );
    }

    const email = positional[0] ?? findOwnerEmail(process.cwd());
    if (!email) {
      throw new Error(
        "No OWNER_EMAIL found in auth/.env or docker-compose.yml. Run this from the project init created, or pass the address: seamless owner-code you@example.com",
      );
    }

    await waitForAuthServer(authUrl, {
      onWaiting: () => {
        if (!json) {
          console.log(
            kleur.dim(`Waiting for the auth server at ${authUrl}...`),
          );
        }
      },
    });

    const code = await requestOwnerCode(authUrl, email);

    if (json) {
      console.log(JSON.stringify({ email, code }, null, 2));
      return;
    }

    console.log(`\nCode for ${kleur.bold(email)}: ${kleur.bold().green(code)}\n`);
    console.log(
      kleur.dim(
        "Enter it on the page that asked for a code. It replaces any code sent before and expires in 5 minutes.",
      ),
    );
    console.log(
      kleur.dim(
        "If you have not registered in the browser yet, register first, then run this again.\n",
      ),
    );
  } catch (err) {
    console.error(kleur.red(errorMessage(err)));
    process.exit(1);
  }
}
