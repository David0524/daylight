// Starts the feed build every 30 minutes. GitHub runs the workflow's own
// schedule hours late under load; a dispatched run starts at once.
// Needs the GH_DISPATCH_TOKEN secret: a fine-grained token for this
// repository with Actions read/write.
export default {
  async scheduled(event, env, ctx) {
    if (!env.GH_DISPATCH_TOKEN) return console.warn("GH_DISPATCH_TOKEN is not set");
    ctx.waitUntil(fetch("https://api.github.com/repos/David0524/daylight/actions/workflows/build-feed.yml/dispatches", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "daylight-cron",
      },
      body: JSON.stringify({ ref: "main" }),
    }).then(r => console.log("dispatch", r.status)));
  },
};
