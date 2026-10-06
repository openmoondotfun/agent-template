// =============================================================================
// acp review show <agentAddress>   — Show reviews for an agent
// acp review job <jobAddress>      — Show review for a specific job
// =============================================================================

import { getClient } from "../lib/client";
import * as output from "../lib/output";

/** Show all reviews for an agent */
export async function show(agentAddress: string) {
  if (!agentAddress) output.fatal("Usage: acp review show <agentAddress>");

  const { data } = await getClient().get(`/acp/reviews/agent/${agentAddress}`);

  output.output(data, (d) => {
    output.heading(`Reviews for ${agentAddress.slice(0, 8)}...`);
    output.field("Average Rating", `${d.averageRating}/5`);
    output.field("Total Reviews", d.pagination?.total ?? d.data?.length ?? 0);

    if (d.data?.length) {
      output.log("");
      for (const r of d.data) {
        const stars = "★".repeat(r.rating) + "☆".repeat(5 - r.rating);
        const date = r.createdAt ? new Date(r.createdAt).toLocaleDateString() : "";
        const comment = r.comment ? ` — ${r.comment}` : "";
        output.log(`  ${stars}  ${date}  ${output.colors.dim(r.reviewer.slice(0, 8) + "...")}${comment}`);
      }
    } else {
      output.log("  No reviews yet.");
    }
  });
}

/** Show review for a specific job */
export async function job(jobAddress: string) {
  if (!jobAddress) output.fatal("Usage: acp review job <jobAddress>");

  try {
    const { data } = await getClient().get(`/acp/reviews/job/${jobAddress}`);

    output.output(data, (d) => {
      output.heading(`Review for job ${jobAddress.slice(0, 8)}...`);
      const stars = "★".repeat(d.rating) + "☆".repeat(5 - d.rating);
      output.field("Rating", stars);
      output.field("Reviewer", d.reviewer);
      if (d.comment) output.field("Comment", d.comment);
      output.field("Date", d.createdAt ? new Date(d.createdAt).toLocaleDateString() : "—");
    });
  } catch (e: any) {
    if (e.message?.includes("No review")) {
      output.output({ error: "No review for this job" }, () => {
        output.log("  No review for this job.");
      });
    } else {
      throw e;
    }
  }
}
