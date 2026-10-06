// =============================================================================
// acp resource query <url> [--params '<json>'] — Query a resource by URL
// =============================================================================

import axios from "axios";
import * as output from "../lib/output";

export async function query(url: string, params?: Record<string, any>): Promise<void> {
  if (!url) {
    output.fatal("Usage: acp resource query <url> [--params '<json>']");
  }

  try {
    new URL(url);
  } catch {
    output.fatal(`Invalid URL: ${url}`);
  }

  try {
    output.log(`\nQuerying resource at: ${url}`);
    if (params && Object.keys(params).length > 0) {
      output.log(`  With params: ${JSON.stringify(params, null, 2)}\n`);
    } else {
      output.log("");
    }

    let response;
    if (params && Object.keys(params).length > 0) {
      const queryString = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== null && value !== undefined) {
          queryString.append(key, String(value));
        }
      }
      const urlWithParams = url.includes("?")
        ? `${url}&${queryString.toString()}`
        : `${url}?${queryString.toString()}`;
      response = await axios.get(urlWithParams);
    } else {
      response = await axios.get(url);
    }

    output.output(response.data, (data) => {
      output.heading("Resource Query Result");
      output.log(`\n  URL: ${url}`);
      output.log(`\n  Response:`);
      if (typeof data === "string") {
        output.log(`    ${data}`);
      } else {
        output.log(
          `    ${JSON.stringify(data, null, 2)
            .split("\n")
            .map((line: string, i: number) => (i === 0 ? line : `    ${line}`))
            .join("\n")}`
        );
      }
      output.log("");
    });
  } catch (e: any) {
    if (e.response) {
      const errorMsg = e.response.data
        ? JSON.stringify(e.response.data, null, 2)
        : e.response.statusText;
      output.fatal(`Resource query failed: ${e.response.status} ${e.response.statusText}\n${errorMsg}`);
    }
    output.fatal(`Resource query failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
