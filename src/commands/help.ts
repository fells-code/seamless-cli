import { VERSION } from "../index.js";
import {
  COMMAND_HELP,
  findCommandHelp,
  type CommandHelp,
} from "./helpTopics.js";

const DIVIDER = "────────────────────────────────────────────";

const DOCS_URL = "https://docs.seamlessauth.com";

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
}

function renderSections(command: CommandHelp, headingIndent: number): string {
  return command.sections
    .map(
      (section) =>
        `${indent(section.heading, headingIndent)}\n${indent(
          section.body,
          headingIndent + 2,
        )}`,
    )
    .join("\n\n");
}

export function printHelp() {
  const usage = COMMAND_HELP.flatMap((c) => c.usage)
    .concat(["seamless <command> --help", "seamless --help", "seamless --version"])
    .map((line) => `  ${line}`)
    .join("\n");

  const commands = COMMAND_HELP.map((c) => renderSections(c, 2)).join("\n\n");

  console.log(`
seamless v${VERSION}

Seamless CLI: scaffold and manage full-stack authentication systems.

${DIVIDER}

USAGE

${usage}

${DIVIDER}

COMMANDS

${commands}

${DIVIDER}

GETTING STARTED

  1. seamless init
  2. docker compose up
  3. Register in the browser with the email you gave init
  4. When it asks for a code: seamless owner-code

    → That address is the owner, so it becomes an admin

${DIVIDER}

WHAT YOU GET

  • Web application (React starter, or a use-case example like --oauth)
  • API server (Express)
  • SeamlessAuth server (Docker or local)
  • Admin dashboard (Docker or source)
  • Docker Compose setup

${DIVIDER}

EXAMPLES

  seamless init
    → Interactive setup in current directory

  seamless init my-app
    → Create new project in ./my-app

  seamless init --oauth my-app
    → Create ./my-app from the OAuth example starter

  seamless check
    → Validate your project

${DIVIDER}

DOCS

  ${DOCS_URL}

`);
}

// Returns false when the command has no help entry, so the caller can fall
// back to the unknown-command path instead of printing an empty topic.
export function printCommandHelp(name: string): boolean {
  const command = findCommandHelp(name);
  if (!command) return false;

  const usage = command.usage.map((line) => `  ${line}`).join("\n");

  // The heading only earns its place when a command has more than one section
  // (sessions list vs sessions revoke); otherwise it just repeats the usage.
  const description =
    command.sections.length === 1
      ? indent(command.sections[0].body, 2)
      : renderSections(command, 2);

  const examples = command.examples?.length
    ? `\nEXAMPLES\n\n${command.examples
        .map((example) => indent(example, 2))
        .join("\n\n")}\n`
    : "";

  console.log(`
seamless ${command.name} (seamless v${VERSION})

USAGE

${usage}

DESCRIPTION

${description}
${examples}
Docs: ${DOCS_URL}
`);

  return true;
}
