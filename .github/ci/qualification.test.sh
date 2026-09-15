#!/usr/bin/env bash
# Test the real release composition in disposable repositories. Only the
# expensive child lanes are stubs; exit handling, ordering, artifact routing,
# and the final tee pipeline belong to the actual qualification script.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec python3 - "$ROOT" "$BASH" <<'PY'
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

root = pathlib.Path(sys.argv[1])
bash = sys.argv[2]
stages = [
    ('run-unit', ['rust-quality'], None),
    ('run-unit', ['rust'], None),
    ('run-unit', ['js'], None),
    ('run-unit', ['go'], None),
    ('run-wamr', [], None),
    ('check-workflows', [], None),
    ('control-interface', [], 'control'),
    ('checkpoint-file', [], 'checkpoint'),
    ('rust-guest', [], 'rust-guest'),
    ('conformance', ['--suite', 'all'], 'conformance'),
    ('semantic-conformance', ['all', '--skip-build'], 'semantics'),
    ('wamr-fixture', ['--skip-build'], 'multi-memory'),
    ('browser-smoke', [], 'browser'),
    ('browser-peer-smoke', [], 'browser-peer'),
    ('browser-sidecar-smoke', [], 'browser-sidecar'),
    ('pi-demo-smoke', [], 'pi-demo'),
    ('adversity', ['all'], 'adversity'),
    ('host-service-baseline', [], 'host-service-baseline'),
]
stub = '''
import json,os,pathlib,sys
record = {'stage': pathlib.Path(sys.argv[0]).stem, 'args': sys.argv[1:],
          'artifacts': os.environ.get('WEAVE_CI_ARTIFACT_DIR'),
          'required_cli': os.environ.get('WEAVE_PI_REQUIRE_CLI'),
          'wazero': os.environ.get('WEAVE_WAZERO_BIN')}
events = pathlib.Path(os.environ['WEAVE_QUALIFICATION_TEST_EVENTS'])
with events.open('a') as stream:
    stream.write(json.dumps(record) + '\\n')
index = len(events.read_text().splitlines())
print('fixture stage ' + str(index), flush=True)
sys.exit(37 if index == int(os.environ['WEAVE_QUALIFICATION_TEST_FAIL']) else 0)
'''

with tempfile.TemporaryDirectory(prefix='weave-qualification-test.') as temporary:
    folder = pathlib.Path(temporary)
    repo = folder / 'repo'
    ci = repo / '.github' / 'ci'
    ci.mkdir(parents=True)
    (folder / 'bin').mkdir()
    (folder / 'bin' / 'bash').symlink_to(bash)
    for name in ('qualification.sh', 'artifact-lifecycle.sh', 'awake-guard.sh'):
        shutil.copy2(root / '.github' / 'ci' / name, ci / name)
    for name, _, _ in stages:
        target = ci / (name + '.sh')
        # control-interface.sh is invoked explicitly through Bash by the real
        # wrapper, so each stub must itself be a shell entry point.
        target.write_text('#!/usr/bin/env bash\nexec ' + json.dumps(sys.executable)
                          + ' - "$0" "$@" <<\'FIXTURE_PY\'\n'
                          + 'import sys\nsys.argv.pop(0)\n' + stub + '\nFIXTURE_PY\n')
        target.chmod(0o755)

    for fail_at in range(len(stages) + 1):
        case = folder / ('case-' + str(fail_at))
        case.mkdir()
        artifacts = case / 'artifacts'
        events = case / 'events.jsonl'
        environment = dict(os.environ)
        for key in ('WEAVE_CI_KEEP_TEMP', 'WEAVE_PI_REQUIRE_CLI', 'WEAVE_WAZERO_BIN'):
            environment.pop(key, None)
        environment.update({
            'PATH': str(folder / 'bin') + os.pathsep + environment['PATH'],
            'WAMR_ROOT': str(folder / 'fixture-wamr'),
            'WEAVE_CI_PREVENT_SLEEP': '0',
            'WEAVE_CI_ARTIFACT_DIR': str(artifacts),
            'WEAVE_QUALIFICATION_TEST_EVENTS': str(events),
            'WEAVE_QUALIFICATION_TEST_FAIL': str(fail_at),
        })
        result = subprocess.run([bash, str(ci / 'qualification.sh')], env=environment,
                                capture_output=True, text=True, timeout=15)
        expected_status = 37 if fail_at else 0
        assert result.returncode == expected_status, (fail_at, result)
        records = [json.loads(line) for line in events.read_text().splitlines()]
        assert len(records) == (fail_at or len(stages)), (fail_at, records)
        for record, (name, arguments, suffix) in zip(records, stages):
            assert record['stage'] == name and record['args'] == arguments, record
            assert record['artifacts'] == (str(artifacts / suffix) if suffix else None), record
            assert record['required_cli'] == ('1' if arguments == ['js'] else None), record
            if name == 'semantic-conformance':
                assert record['wazero'] == str(artifacts / 'conformance/bin/weave-wazero'), record
        assert artifacts.is_dir(), 'explicit artifacts must remain available'
        if fail_at in (0, len(stages)):
            assert (artifacts / 'host-service-baseline.log').read_text() == 'fixture stage 18\n'
        print(f'ok {fail_at + 1} - qualification ' +
              ('success visits all 18 lanes' if fail_at == 0 else
               f'failure in lane {fail_at} propagates exit 37 and stops subsequent work'), flush=True)

print('PASS qualification composition (19 fixture cases; no builds or browsers)')
PY
