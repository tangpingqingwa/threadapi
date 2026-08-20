const DEFAULT_PORT = 3000;
const DEFAULT_DATABASE_PATH = "./data/threadapi.sqlite";

export type AdapterKind = "fixture" | "live";

export type AppConfig = {
  port: number;
  databasePath: string;
  bootstrapKey: string | undefined;
  nodeEnv: string;
  adapter: AdapterKind;
};

export function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/** Live X is off unless THREADAPI_LIVE=1 or THREADAPI_ADAPTER=live. CI forces fixture. */
export function resolveAdapterKind(env: NodeJS.ProcessEnv = process.env): AdapterKind {
  if (isTruthyEnv(env.THREADAPI_FIXTURE_ONLY)) {
    return "fixture";
  }
  const named = (env.THREADAPI_ADAPTER ?? "").trim().toLowerCase();
  if (named === "live") {
    return "live";
  }
  if (named === "fixture" || named === "") {
    return isTruthyEnv(env.THREADAPI_LIVE) ? "live" : "fixture";
  }
  throw new Error(
    `THREADAPI_ADAPTER must be fixture or live, got ${JSON.stringify(env.THREADAPI_ADAPTER)}`,
  );
}

export function parseListenPort(value = process.env.PORT): number {
  if (value === undefined || value === "") {
    return DEFAULT_PORT;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer 1-65535, got ${JSON.stringify(value)}`);
  }
  return port;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  const databasePath = env.THREADAPI_DATABASE;
  if ((databasePath === undefined || databasePath === "") && nodeEnv === "production") {
    throw new Error("THREADAPI_DATABASE is required in production");
  }
  const bootstrapKey = env.THREADAPI_BOOTSTRAP_KEY;
  return {
    port: parseListenPort(env.PORT),
    databasePath:
      databasePath !== undefined && databasePath !== ""
        ? databasePath
        : DEFAULT_DATABASE_PATH,
    bootstrapKey:
      bootstrapKey !== undefined && bootstrapKey !== "" ? bootstrapKey : undefined,
    nodeEnv,
    adapter: resolveAdapterKind(env),
  };
}
