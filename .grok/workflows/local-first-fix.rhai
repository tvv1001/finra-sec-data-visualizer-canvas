let meta = #{
    name: "local-first-fix",
    description: "Diagnose a production URL as an example, implement locally, never deploy or push Redis",
    when_to_use: "User pasted a vercel.app URL or described a prod bug. Fix it locally only.",
    phases: [
        #{ title: "Diagnose", detail: "read-only: code plus optional prod URL as an example" },
        #{ title: "Implement", detail: "local code and local Redis only" },
        #{ title: "Verify", detail: "local tests; stop without Vercel or Redis push" },
    ],
};

let plan_schema = #{
    "type": "object",
    "required": ["summary", "files", "redis_key", "local_check"],
    "properties": #{
        "summary": #{ "type": "string" },
        "files": #{ "type": "array", "maxItems": 12, "items": #{ "type": "string" } },
        "redis_key": #{ "type": "string" },
        "local_check": #{ "type": "string" },
    },
};

let implement_schema = #{
    "type": "object",
    "required": ["changed_files", "did_deploy", "did_push_redis", "notes"],
    "properties": #{
        "changed_files": #{ "type": "array", "maxItems": 20, "items": #{ "type": "string" } },
        "did_deploy": #{ "type": "boolean" },
        "did_push_redis": #{ "type": "boolean" },
        "notes": #{ "type": "string" },
    },
};

let verify_schema = #{
    "type": "object",
    "required": ["ok", "evidence", "deployed", "pushed_redis"],
    "properties": #{
        "ok": #{ "type": "boolean" },
        "evidence": #{ "type": "string" },
        "deployed": #{ "type": "boolean" },
        "pushed_redis": #{ "type": "boolean" },
    },
};

let issue = if args == () { () } else { args.issue };
if issue == () { pause("verification", "Pass args.issue describing the bug. Optional args.prod_url is an example only."); }

let prod_url = if args == () { () } else { args.prod_url };
let issue_json = json_encode(issue);
let url_json = json_encode(prod_url);

phase("Diagnose");
let diagnose_prompt = "You are diagnosing a bug in finra-data-chart-next-02. ";
diagnose_prompt += "Use grep and read_file on the repo. Do not write files. Do not run vercel. Do not write Upstash. ";
diagnose_prompt += "Production URLs are EXAMPLES of the issue, not a request to change production. ";
diagnose_prompt += "Issue (JSON): " + issue_json + " ";
diagnose_prompt += "Optional example prod URL (JSON, may be null): " + url_json + " ";
diagnose_prompt += "Firm people lists come from Redis key firm-connections:firm:{id} via /api/finra/firm/{id}/connections. ";
diagnose_prompt += "Local Redis is 127.0.0.1:6379 when USE_LOCAL_REDIS=1. ";
diagnose_prompt += "Return summary, files to change, redis_key if relevant, and local_check (curl or test to run later).";

let diagnosed = agent(diagnose_prompt, #{
    label: "diagnose",
    capability_mode: "read-only",
    output_schema: plan_schema,
});

if diagnosed == () || !diagnosed.success || diagnosed.output == () {
    complete(#{ summary: "Diagnose failed; no code changes.", ok: false });
}

phase("Implement");
let plan_json = json_encode(diagnosed.output);
let implement_prompt = "Implement the local-only fix for finra-data-chart-next-02. ";
implement_prompt += "HARD RULES: never run vercel deploy or pnpm vercel:deploy. ";
implement_prompt += "Never push local Redis to prod Redis / Upstash. Never dual-write local SET to Upstash. ";
implement_prompt += "A production URL is an example only. Write code against localhost and local Redis. ";
implement_prompt += "Plan (JSON): " + plan_json + " ";
implement_prompt += "Issue (JSON): " + issue_json + " ";
implement_prompt += "Edit the listed files. Keep firm connections on Redis firm-connections:firm:{id}. ";
implement_prompt += "Set did_deploy=false and did_push_redis=false. If you cannot follow those, do not change production.";

let implemented = agent(implement_prompt, #{
    label: "implement",
    capability_mode: "read-write",
    output_schema: implement_schema,
});

if implemented == () || !implemented.success || implemented.output == () {
    complete(#{ summary: "Implement failed.", ok: false, plan: diagnosed.output });
}

phase("Verify");
let impl_json = json_encode(implemented.output);
let verify_prompt = "Verify the local fix. Use tests or curl against http://localhost:4444 only. ";
verify_prompt += "Do not deploy to Vercel. Do not push Redis to Upstash. ";
verify_prompt += "Issue (JSON): " + issue_json + " ";
verify_prompt += "Implement result (JSON): " + impl_json + " ";
verify_prompt += "Set deployed=false and pushed_redis=false. ok=true only if local evidence supports the fix.";

let verified = agent(verify_prompt, #{
    label: "verify",
    capability_mode: "read-only",
    output_schema: verify_schema,
});

let verify_ok = verified != () && verified.success && verified.output != () && verified.output.ok == true;
let report = "# local-first-fix\n\n";
report += "Issue: " + issue_json + "\n\n";
report += "Plan: " + plan_json + "\n\n";
report += "Implement: " + impl_json + "\n\n";
if verified != () && verified.success && verified.output != () {
    report += "Verify: " + json_encode(verified.output) + "\n";
} else {
    report += "Verify: failed or empty\n";
}
report += "\nProduction was not deployed. Redis was not pushed to prod.\n";
let path = write_scratch_file("report.md", report);

complete(#{
    summary: if verify_ok { "Local fix verified. Not deployed. Redis not pushed." } else { "Local work finished without a passing verify." },
    ok: verify_ok,
    path: path,
    deployed: false,
    pushed_redis: false,
});
