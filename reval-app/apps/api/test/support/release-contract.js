import assert from "node:assert/strict";
import specification from "../../../../docs/openapi.v1.json" with { type: "json" };

const routes = Object.entries(specification.paths).map(([path, methods]) => ({
  pattern: new RegExp(
    "^" + path.replace(/[.]/g, "\\.").replace(/\{[^}]+\}/g, "[^/]+") + "$",
  ),
  methods,
}));

function conforms(schema, value, where) {
  if (schema.$ref) {
    const name = schema.$ref.split("/").at(-1);
    assert.ok(
      specification.components.schemas[name],
      where + " missing schema " + name,
    );
    return conforms(specification.components.schemas[name], value, where);
  }
  if (schema.enum)
    assert.ok(
      schema.enum.includes(value),
      where + " invalid choice " + String(value),
    );
  if (schema.type === "object") {
    assert.ok(
      value && typeof value === "object" && !Array.isArray(value),
      where + " expected object",
    );
    for (const key of schema.required ?? [])
      assert.ok(Object.hasOwn(value, key), where + " missing " + key);
    for (const [key, child] of Object.entries(schema.properties ?? {}))
      if (Object.hasOwn(value, key))
        conforms(child, value[key], where + "." + key);
  } else if (schema.type === "array") {
    assert.ok(Array.isArray(value), where + " expected list");
    value.forEach((row, index) =>
      conforms(schema.items, row, where + "[" + index + "]"),
    );
  } else if (schema.type === "integer") {
    assert.ok(Number.isInteger(value), where + " expected integer");
    if (schema.minimum !== undefined)
      assert.ok(value >= schema.minimum, where + " below minimum");
  } else {
    assert.equal(typeof value, schema.type, where);
    if (schema.pattern) assert.match(value, new RegExp(schema.pattern), where);
  }
}

export function assertContractResponse(method, path, status, body) {
  const url = new URL(path, "http://localhost");
  const operation = routes.find(
    (route) =>
      route.pattern.test(url.pathname) && route.methods[method.toLowerCase()],
  )?.methods[method.toLowerCase()];
  if (!operation) return false;
  assert.ok(
    status >= 400 || operation.responses[status],
    operation.operationId + " undocumented success status " + status,
  );
  const declared = operation.responses[status] ?? operation.responses.default;
  const schema = declared.content?.["application/json"]?.schema;
  if (schema) conforms(schema, body, operation.operationId);
  if (status === 204) assert.equal(body, null, operation.operationId);
  return true;
}
