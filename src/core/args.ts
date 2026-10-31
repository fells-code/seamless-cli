// A literal `--` ends flag parsing, so a later -h belongs to the command's
// operands (a config value, say) rather than being a request for help.
export function hasHelpFlag(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--") return false;
    if (arg === "-h" || arg === "--help") return true;
  }
  return false;
}

export interface ExtractedFlag {
  value?: string;
  rest: string[];
}

export function extractFlag(args: string[], name: string): ExtractedFlag {
  const rest: string[] = [];
  let value: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === `--${name}`) {
      value = args[i + 1];
      i++;
    } else if (arg.startsWith(`--${name}=`)) {
      value = arg.slice(name.length + 3);
    } else {
      rest.push(arg);
    }
  }

  return { value, rest };
}

/** Every value of a flag that may be given more than once, in order. */
export function extractRepeatedFlag(
  args: string[],
  name: string,
): { values: string[]; rest: string[] } {
  const values: string[] = [];
  let rest = args;

  for (;;) {
    const next = extractFirstFlag(rest, name);
    if (next.value === undefined) return { values, rest: next.rest };
    values.push(next.value);
    rest = next.rest;
  }
}

function extractFirstFlag(args: string[], name: string): ExtractedFlag {
  const index = args.findIndex(
    (arg) => arg === `--${name}` || arg.startsWith(`--${name}=`),
  );
  if (index === -1) return { rest: args };

  const arg = args[index];
  if (arg === `--${name}`) {
    return {
      value: args[index + 1] ?? "",
      rest: [...args.slice(0, index), ...args.slice(index + 2)],
    };
  }
  return {
    value: arg.slice(name.length + 3),
    rest: [...args.slice(0, index), ...args.slice(index + 1)],
  };
}

/** A pair of switches such as `--notices` and `--no-notices`, or undefined when neither is given. */
export function extractSwitch(
  args: string[],
  on: string,
  off: string,
): { value?: boolean; rest: string[] } {
  let value: boolean | undefined;
  const rest = args.filter((arg) => {
    if (arg === `--${on}`) value = true;
    else if (arg === `--${off}`) value = false;
    else return true;
    return false;
  });
  return { value, rest };
}
