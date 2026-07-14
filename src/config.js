import "dotenv/config";

function required(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(
      `Environment variable ${name} is required.`
    );
  }

  return value;
}

function integer(
  name,
  fallback,
  {
    min = 0,
    max = 2_147_483_647
  } = {}
) {
  const raw = process.env[name]?.trim();

  if (!raw) {
    return fallback;
  }

  if (!/^-?\d+$/.test(raw)) {
    throw new Error(
      `${name} must be an integer.`
    );
  }

  const value = Number(raw);

  if (
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(
      `${name} must be between ${min} and ${max}.`
    );
  }

  return value;
}

function boolean(name, fallback) {
  const raw = process.env[name]
    ?.trim()
    .toLowerCase();

  if (!raw) {
    return fallback;
  }

  if (
    ["true", "1", "yes", "on"].includes(raw)
  ) {
    return true;
  }

  if (
    ["false", "0", "no", "off"].includes(raw)
  ) {
    return false;
  }

  throw new Error(
    `${name} must be true or false.`
  );
}

const pterodactylUrl = required(
  "PTERODACTYL_URL"
).replace(/\/+$/, "");

try {
  new URL(pterodactylUrl);
} catch {
  throw new Error(
    "PTERODACTYL_URL must be a valid URL."
  );
}

export const config = Object.freeze({
  discordToken: required("DISCORD_TOKEN"),
  guildId: required("GUILD_ID"),
  roleId: required("ROLE_ID"),

  pterodactylUrl,

  pterodactylApiKey: required(
    "PTERODACTYL_API_KEY"
  ),

  defaultOwnerEmail:
    process.env.DEFAULT_OWNER_EMAIL?.trim() ||
    "yappingfest24@gmail.com",

  autoCreatePanelUsers: boolean(
    "AUTO_CREATE_PANEL_USERS",
    true
  ),

  featureLimits: Object.freeze({
    databases: integer(
      "FEATURE_DATABASES",
      0
    ),

    allocations: integer(
      "FEATURE_ALLOCATIONS",
      0
    ),

    backups: integer(
      "FEATURE_BACKUPS",
      0
    )
  }),

  serverSwapMb: integer(
    "SERVER_SWAP_MB",
    0,
    {
      min: -1
    }
  ),

  serverIoWeight: integer(
    "SERVER_IO_WEIGHT",
    500,
    {
      min: 10,
      max: 1_000
    }
  ),

  requestTimeoutMs: integer(
    "REQUEST_TIMEOUT_MS",
    20_000,
    {
      min: 1_000,
      max: 120_000
    }
  )
});