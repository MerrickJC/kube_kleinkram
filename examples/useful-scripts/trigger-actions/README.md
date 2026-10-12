# Trigger scripts

Two standalone scripts that use the `kleinkram` Python package (the same
package the `klein` CLI is built on) to launch an action template against
missions:

- `trigger_missions.py` - launches a template against an explicit list of
  missions (by UUID, or by name with `--project`).
- `trigger_all_missions.py` - lists every mission visible to the
  authenticated account (optionally scoped to one `--project`) and launches
  a template against each of them.

Both scripts keep going if one mission fails, print `[OK]`/`[FAIL]` per
mission, and exit with a non-zero code if any mission failed. Both support
`--dry-run` to see what would be launched without actually launching
anything.

## Install

```bash
pip install kleinkram
```

## Authenticating in a container

`klein login` is interactive (it opens a browser or asks you to paste a
token), which doesn't work non-interactively inside a Docker container. The
`kleinkram` package also supports authenticating purely from environment
variables, with no config file and no login step - this is the same
mechanism Kleinkram uses to authenticate actions when they run on the
platform, and these scripts rely on it.

Set these three environment variables before running the scripts:

| Variable                 | Value                                                                |
|---------------------------|-----------------------------------------------------------------------|
| `KLEINKRAM_API_KEY`       | A CLI/API key for your account.                                      |
| `KLEINKRAM_API_ENDPOINT`  | The API URL of your deployment, e.g. `https://api.your-domain.com`.  |
| `KLEINKRAM_S3_ENDPOINT`   | The S3/MinIO URL of your deployment, e.g. `https://s3.your-domain.com`. |

### Getting an API key

Log in to your Kleinkram web UI once with a normal account, open your user
profile, and generate a CLI/API key from the "API Keys" section. Treat this
key like a password - anyone with it can act as your account against your
deployment.

### Running in Docker

Pass the variables in with `-e` (or `--env-file`), don't bake them into the
image:

```bash
docker run --rm \
  -e KLEINKRAM_API_KEY=... \
  -e KLEINKRAM_API_ENDPOINT=https://api.your-domain.com \
  -e KLEINKRAM_S3_ENDPOINT=https://s3.your-domain.com \
  -v "$(pwd)/examples/trigger-scripts:/scripts" \
  python:3.11-slim \
  bash -c "pip install -q kleinkram && python /scripts/trigger_all_missions.py --template my-template --dry-run"
```

If your deployment's API/S3 endpoints are only reachable on an internal
network (VPN, private DNS, etc.), the container needs network access to
reach them - e.g. run it on a host that's on that network, or add it to the
relevant Docker network with `--network`.

## Usage

```bash
# launch a template against specific missions (by UUID)
python trigger_missions.py \
  --template my-template \
  --mission 11111111-1111-1111-1111-111111111111 \
  --mission 22222222-2222-2222-2222-222222222222

# or from a file, one UUID/name per line
python trigger_missions.py --template my-template --missions-file missions.txt

# mission names require --project to disambiguate
python trigger_missions.py --template my-template --project my-project --mission some-mission-name

# launch a template against every mission in the deployment
python trigger_all_missions.py --template my-template

# scope to one project
python trigger_all_missions.py --template my-template --project my-project
```

`--template` accepts either the template's name or its UUID.
