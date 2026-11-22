/** @param {NodeJS.ProcessEnv} env */
export function readConfig(env) {
  const mode = env.NODE_ENV ?? "development";
  const databaseNames = {
    development: /^reval_dev$/,
    test: /^reval_test(?:_[a-z0-9]+)?$/,
    staging: /^reval_staging$/,
    production: /^reval$/,
  };

  if (!(
    mode === "development" ||
    mode === "test" ||
    mode === "staging" ||
    mode === "production"
  )) {
    throw new Error(
      "NODE_ENV must be development, test, staging or production.",
    );
  }

  const uri = env.MONGODB_URI;
  const parts = uri?.match(
    /^mongodb(\+srv)?:\/\/([^/]+)\/([^?/#]+)(?:\?([^#]+))?$/,
  );
  if (!parts || !uri) {
    throw new Error(
      "MONGODB_URI must be a MongoDB URI with an explicit database name.",
    );
  }

  const options = new URLSearchParams(parts[4]);
  if (!options.get("replicaSet")) {
    throw new Error("MONGODB_URI must specify a replicaSet.");
  }
  if (!databaseNames[mode].test(parts[3])) {
    throw new Error(
      "MONGODB_URI database is outside the allowed namespace for NODE_ENV.",
    );
  }
  if (
    (mode === "staging" || mode === "production") &&
    !parts[2].includes("@")
  ) {
    throw new Error(
      "MONGODB_URI must include database credentials for staging and production.",
    );
  }

  const host = env.HOST ?? "127.0.0.1";
  const port = Number(env.PORT ?? "4000");
  if (!host.trim() || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("HOST and PORT must identify a valid listen address.");
  }
  const seed = env.ALLOW_DEMO_SEED ?? "false";
  if (seed !== "true" && seed !== "false") {
    throw new Error("ALLOW_DEMO_SEED must be true or false.");
  }
  if (seed === "true" && mode !== "development" && mode !== "test") {
    throw new Error("Demo seed is allowed only in development and test.");
  }

  return { uri, host, port, allowDemoSeed: seed === "true" };
}

/** @param {NodeJS.ProcessEnv} env */
export function readIdentityOptions(env) {
  const origin = env.APP_ORIGIN ?? "http://127.0.0.1:5173";
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error("APP_ORIGIN must be the browser origin.");
  }
  if (
    parsed.origin !== origin ||
    !(
      parsed.protocol === "https:" ||
      (parsed.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(parsed.hostname))
    ) ||
    (["staging", "production"].includes(env.NODE_ENV ?? "") &&
      parsed.protocol !== "https:")
  ) {
    throw new Error(
      "APP_ORIGIN must be HTTPS in staging and production. HTTP is allowed on loopback in development and test.",
    );
  }
  const ttl = Number(env.SESSION_TTL_SECONDS ?? "28800");
  if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 86400) {
    throw new Error(
      "SESSION_TTL_SECONDS must be an integer between 60 and 86400.",
    );
  }
  const mode = env.NODE_ENV ?? "development";
  if (
    (mode === "development" || mode === "test") &&
    parsed.protocol === "http:"
  ) {
    parsed.hostname =
      parsed.hostname === "localhost" ? "127.0.0.1" : "localhost";
    return { origin, ttl, loopbackAlias: parsed.origin };
  }
  return { origin, ttl };
}
