export interface OptionDefinition {
  type: "string" | "number" | "boolean";
  required?: boolean;
  choices?: readonly string[];
  description: string;
}

export interface CommandDefinition {
  summary: string;
  options: Record<string, OptionDefinition>;
  positionals?: { name: string; required?: boolean; description: string }[];
  mutuallyExclusive?: string[][];
}

export interface ParsedCommandArgs {
  options: Record<string, string | number | boolean>;
  positionals: string[];
}

export function parseStrictArgs(argv: string[], definition: CommandDefinition): ParsedCommandArgs {
  const options: Record<string, string | number | boolean> = {};
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "-h") {
      options.help = true;
      continue;
    }
    if (!token.startsWith("--")) {
      if (token.startsWith("-")) throw new Error(`Unknown short option '${token}'. Use --help to list supported options.`);
      positionals.push(token);
      continue;
    }
    const [rawName, inlineValue] = token.slice(2).split(/=(.*)/s, 2);
    const option = rawName === "help" ? { type: "boolean" as const, description: "Show help." } : definition.options[rawName];
    if (!option) throw new Error(`Unknown option '--${rawName}'. Use --help to list supported options.`);
    if (Object.hasOwn(options, rawName)) throw new Error(`Option '--${rawName}' was provided more than once.`);
    if (option.type === "boolean") {
      if (inlineValue !== undefined) throw new Error(`Boolean option '--${rawName}' does not accept a value.`);
      options[rawName] = true;
      continue;
    }
    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Option '--${rawName}' requires a value.`);
    if (inlineValue === undefined) index += 1;
    if (option.type === "number") {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) throw new Error(`Option '--${rawName}' must be a number, received '${value}'.`);
      options[rawName] = numeric;
    } else {
      if (option.choices && !option.choices.includes(value)) throw new Error(`Option '--${rawName}' must be one of: ${option.choices.join(", ")}.`);
      options[rawName] = value;
    }
  }
  if (!options.help) {
    for (const [name, option] of Object.entries(definition.options)) {
      if (option.required && !Object.hasOwn(options, name)) throw new Error(`Missing required option '--${name}'.`);
    }
    for (const [index, positional] of (definition.positionals ?? []).entries()) {
      if (positional.required && !positionals[index]) throw new Error(`Missing required argument '<${positional.name}>'.`);
    }
    if (positionals.length > (definition.positionals?.length ?? 0)) throw new Error(`Unexpected argument '${positionals[definition.positionals?.length ?? 0]}'.`);
    for (const group of definition.mutuallyExclusive ?? []) {
      const selected = group.filter((name) => Boolean(options[name]));
      if (selected.length > 1) throw new Error(`Options ${selected.map((name) => `--${name}`).join(" and ")} are mutually exclusive.`);
    }
  }
  return { options, positionals };
}

export function commandHelp(name: string, definition: CommandDefinition) {
  const positional = (definition.positionals ?? []).map((item) => item.required ? `<${item.name}>` : `[${item.name}]`).join(" ");
  const lines = [`Usage: scene-gen ${name}${positional ? ` ${positional}` : ""} [options]`, "", definition.summary, "", "Options:"];
  for (const [optionName, option] of Object.entries(definition.options)) {
    const value = option.type === "boolean" ? "" : option.type === "number" ? " <number>" : " <value>";
    const choices = option.choices ? ` Choices: ${option.choices.join(", ")}.` : "";
    const required = option.required ? " Required." : "";
    lines.push(`  --${optionName}${value}`.padEnd(30) + `${option.description}${choices}${required}`);
  }
  lines.push("  --help".padEnd(30) + "Show command help.");
  return lines.join("\n");
}
