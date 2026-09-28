# Runbook: Read and Re-point the About Page's Deployment Record

Use this when you operate a deployment and want to answer "what is actually
deployed here?" from inside the running app, or when the **About** page
(`/admin/settings/about`, `system_settings:read`) says no deployment record
was found. `/admin/settings/deployment` redirects to the same page.

The design (why About is one page, why the endpoint always answers `200`, why
the document is read leniently) is in
[`docs/specs/vps-deploy.md`](../specs/vps-deploy.md). Installing and updating
a deployment is [`docs/runbooks/deploy-to-vps.md`](deploy-to-vps.md).

Source of truth for every claim below:

- `apps/api/src/about/about.controller.ts` / `about.service.ts` — the single
  `GET /api/admin/about` route and what it assembles.
- `apps/api/src/about/deploy-info.ts` — reads and validates the document.
- `apps/api/src/about/dto/about-response.dto.ts` — the full response shape.
- `apps/web/src/pages/Admin/AboutPage.tsx` — the page itself.
- `apps/cli/src/deploy/deploy-info.ts` — builds and atomically writes the
  document.
- `apps/cli/src/deploy/about.ts` — `appctl deploy about`, which reads the same
  file from the host side.
- `infra/compose/vps.compose.yml` — the bind mount that carries the document
  into the API container.

---

## 1. Before you start

- The record is `deploy-info/info.json` inside the deployment root. The CLI
  writes it, not the application: once when `/api/health/ready` first answers
  during `appctl deploy install`/`update`, and again at the end of a
  successful run.
- The write is atomic (temp file plus rename), and the **directory** is
  bind-mounted read-only into the API container. A redeploy is picked up on
  the page's **Refresh** button with no restart. Nothing on the page polls.
- On the host, `appctl deploy about` reads the same file without needing the
  API to be up or a login. When the page and the command disagree, the mount
  is the problem.
- The document never holds a secret.

## 2. What the page shows

| Section / field | Meaning |
|---|---|
| This deployment | Name, version, commit, ref, domain, last command, bind port, proxy, certificate expiry, install/update times, `appctl` version, and "Record read from" (`deployInfoPath`). |
| Deploy run | Steps completed; for a failed run, `run.failedStep`. |
| Host | Hostname, OS, kernel, CPUs, memory, Docker/Compose versions **as observed at deploy time**. |
| This API process | `runtime`: process start, Node version, `NODE_ENV`. The one live section. |
| Database | Live liveness probe (`up`/`down`, response time). A failure degrades only this section. |
| Deployment history | The last 20 successful `install`/`update` runs, newest first. |
| `deployInfoStatus: "ok"` | Document read. With `run.outcome: "failure"` the run failed after the health gate; every fact still renders, plus a warning naming the failed step. |
| `deployInfoStatus: "absent"` | No file at `deployInfoPath`. Not evidence that `appctl` was never used. |
| `deployInfoStatus: "invalid"` | The file exists but is unreadable or its `schema` is not `1`. |

## 3. Re-point the mount

The bind mount lives in `infra/compose/vps.compose.yml`:

```yaml
volumes:
  - ${DEPLOY_ROOT:-./.deploy}/deploy-info:/app/deploy-info:ro
environment:
  - DEPLOY_INFO_PATH=${DEPLOY_INFO_PATH:-/app/deploy-info/info.json}
```

`DEPLOY_ROOT` is written into `.env` by the CLI and is deliberately absent
from `.env.example`: the CLI uses it as the marker for an `.env` it wrote
(`apps/cli/src/deploy/deployment-evidence.ts`). The `./.deploy` default only
keeps `docker compose config` valid in a checkout that was never deployed.

1. **Move the directory, if you are moving the root.** Nothing moves it for
   you. Create `<new-root>/deploy-info/` before the stack starts, owned by the
   account that runs `appctl`:

   ```bash
   mkdir -p <new-root>/deploy-info
   mv <old-root>/deploy-info/info.json <new-root>/deploy-info/
   ```

2. **Set `DEPLOY_ROOT`** in the deployment's `.env` to `<new-root>`. This
   changes where on the host `deploy-info/` is read from.
3. **Set `DEPLOY_INFO_PATH` only if you changed the mount target** in
   `vps.compose.yml`. It is the path inside the container. Leave it alone
   otherwise.
4. **Recreate the container** from `infra/compose`, with the same file
   layering the deployment already uses:

   ```bash
   docker compose -f base.compose.yml -f prod.compose.yml -f vps.compose.yml up -d
   ```

5. **Verify.** On the host, `appctl deploy about` prints the record. On the
   page, press **Refresh**: "Record read from" shows the new path and
   `deployInfoStatus` is `ok`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Page says no record was found; `appctl deploy about` shows one | The bind mount is not attached, or `DEPLOY_ROOT` points elsewhere | Check `DEPLOY_ROOT` in `.env` and recreate the container (§3 step 4). |
| Both say no record | The run stopped before the health gate, or the deployment predates the record | Run `appctl deploy update`; the record is written once the API is healthy. |
| Record is stale after a deploy that reported success | The CLI write failed with `EACCES`: Docker created a missing mount source as `root:root`. Writing the record is not a pipeline step, so the deploy stays green. | `chown` `<root>/deploy-info/` to the account that runs `appctl`, then redeploy. |
| `deployInfoStatus: "invalid"` | Corrupt or hand-edited file, or `schema` is not `1` | Inspect the file; a redeploy rewrites it. |
| A failure warning with every fact shown | The run failed after the health gate (`run.outcome: "failure"`) | Read `run.failedStep`, fix it, and re-run `appctl deploy update`. |

## Summary checklist

- [ ] `<root>/deploy-info/` exists and is owned by the account that runs `appctl`
- [ ] `DEPLOY_ROOT` in `.env` names that root
- [ ] `DEPLOY_INFO_PATH` changed only if the mount target changed
- [ ] Container recreated after changing either
- [ ] `appctl deploy about` and the About page agree, and `deployInfoStatus` is `ok`
