/// <reference path="./.sst/platform/config.d.ts" />
export default $config({
  app(input) {
    return {
      name: "personal",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage),
      home: "aws",
      providers: {
        aws: {
          profile: "Personal",
        },
        cloudflare: "6.3.0",
      },
    };
  },
  async run() {
    let outputs = {};
    const { readdirSync } = await import("fs");
    for (const sst of readdirSync("./infra/")) {
      const result = await import("./infra/" + sst);
      if (result.output) {
        Object.assign(outputs, result.output);
      }
    }
    return outputs;
  },
});
