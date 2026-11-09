import { declareDiscoveryExtension as declareSdkDiscoveryExtension } from "@x402/extensions/bazaar";

// The installed SDK emits output only for JSON examples. Preserve binary metadata
// without inventing a JSON example, and describe it in the declaration schema too.
export function declareDiscoveryExtension(config) {
  const extension = declareSdkDiscoveryExtension(config);
  const { output } = config;
  extension.bazaar.info.output = output;
  extension.bazaar.schema.properties.output = {
    type: "object",
    properties: {
      type: { type: "string", const: output.type },
      format: { type: "string", const: output.format },
    },
    required: ["type", "format"],
    additionalProperties: false,
  };
  return extension;
}
