#!/usr/bin/env python3
"""Portable-worker release adapter over the unchanged common forge publisher.

The unprivileged build tests and packages exact Git source. The protected signer
only validates/signs those bytes. Mirrors verify the pinned RSA signature before
publishing identical canonical assets. No deployment occurs in this program.
"""
import argparse
import base64
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tempfile
import urllib.parse
import zipfile

import fleetci as common

ARCHIVE = 'fleet-worker-portable.zip'
MANIFEST = 'portable-manifest.json'
FIELDS = ('component', 'version_code', 'version_name', 'url', 'sha256')
COMPONENT = 'worker-portable'
CANONICAL_BASE = 'https://github.com/hawkab/distributed-workers-portable/releases/download/'
ROOT_FILES = {'VERSION.json', 'update-sources.example.json', 'package.json', 'README.md', 'PROXY.md', 'LICENSE', 'LICENSE.txt'}

def runtime_name(name):
    return (name in ROOT_FILES or name == 'assets/release-public.der' or
            name.startswith('node/') and name.endswith(('.mjs', '.cjs')) or
            name.startswith('php/') and name.endswith('.php'))


def version(root, tag):
    try:
        value = json.loads((root / 'ci/version.json').read_bytes())
        if not common.TAG.fullmatch(tag):
            raise common.Failure('version_tag_required')
        if (set(value) != {'name', 'code'} or type(value['code']) is not int or
                value['code'] <= 0 or tag != 'v' + value['name']):
            raise common.Failure('portable_tag_version_mismatch')
        return value
    except (KeyError, TypeError, ValueError, OSError):
        raise common.Failure('portable_version_invalid') from None


def signature_bytes(manifest):
    return ''.join(str(manifest[key]) + '\n' for key in FIELDS).encode('utf-8')


def canonical_url(tag):
    if not common.TAG.fullmatch(tag):
        raise common.Failure('version_tag_required')
    return CANONICAL_BASE + urllib.parse.quote(tag, safe='') + '/' + ARCHIVE


def runtime_entries(root, commit):
    """Read immutable tag blobs/modes, never mutable files or ignored state."""
    entries = []
    listing = common.run(['git', 'ls-tree', '-rz', '--full-tree', commit], cwd=root)
    for raw in listing.split(b'\0'):
        if not raw:
            continue
        metadata, path_raw = raw.split(b'\t', 1)
        mode, kind, blob = metadata.decode().split(' ')
        name = path_raw.decode('utf-8')
        if not runtime_name(name):
            continue
        pure = PurePosixPath(name)
        if pure.is_absolute() or any(part in ('', '.', '..') for part in pure.parts) or '\\' in name:
            raise common.Failure('portable_source_path_invalid')
        if kind != 'blob' or mode not in ('100644', '100755'):
            raise common.Failure('portable_source_symlink_or_submodule')
        data = common.run(['git', 'cat-file', 'blob', blob], cwd=root)
        entries.append((name, data, 0o755 if mode == '100755' else 0o644))
    names = {entry[0] for entry in entries}
    required = {'node/main.mjs', 'php/worker.php', 'assets/release-public.der',
                'VERSION.json', 'update-sources.example.json'}
    if not required <= names:
        raise common.Failure('portable_runtime_files_missing')
    return entries


def check_sources_template(raw):
    try:
        value = json.loads(raw)
        if isinstance(value, dict) and set(value) != {'sources'}:
            raise ValueError()
        sources = value['sources'] if isinstance(value, dict) else value
        if not isinstance(sources, list) or len(sources) != 3:
            raise ValueError()
        if [source.get('id') for source in sources] != ['gitea', 'gitflic', 'github']:
            raise ValueError()
        first = urllib.parse.urlsplit(sources[0]['url'])
        if first.scheme != 'https' or first.hostname != 'gitea.invalid':
            raise ValueError()
        for source in sources:
            if set(source) - {'id', 'kind', 'url', 'archive_url_template'}:
                raise ValueError()
            kind = source.get('kind', 'channel' if source['id'] == 'gitflic' else 'manifest')
            allowed_kinds = {'gitea': {'gitea', 'manifest'}, 'gitflic': {'channel'}, 'github': {'manifest'}}
            if kind not in allowed_kinds[source['id']]:
                raise ValueError()
            if kind == 'gitea' and not urllib.parse.urlsplit(source['url']).path.endswith('/releases/latest'):
                raise ValueError()
            for key in ('url', 'archive_url', 'archive_url_template'):
                if key not in source:
                    continue
                parsed = urllib.parse.urlsplit(source[key])
                if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.fragment:
                    raise ValueError()
                if source['id'] == 'gitflic' and (parsed.hostname != 'gitflic.ru' or set(urllib.parse.parse_qs(parsed.query)) != {'file', 'commit'}):
                    raise ValueError()
                if source['id'] != 'gitflic' and parsed.query:
                    raise ValueError()
                if source['id'] == 'github' and parsed.hostname != 'github.com':
                    raise ValueError()
        gitflic = urllib.parse.parse_qs(urllib.parse.urlsplit(sources[1]['url']).query)
        if gitflic.get('commit') != ['release-channel'] or 'branch' in gitflic:
            raise ValueError()
    except (KeyError, TypeError, ValueError, UnicodeError):
        raise common.Failure('portable_public_sources_template_invalid') from None


def inspect_archive(root, archive_path, expected_version, *, environment=None, commit=None):
    """Inspect without extraction; reject private state, links and path tricks."""
    env = os.environ if environment is None else environment
    try:
        expected = ({name: (data, mode) for name, data, mode in runtime_entries(root, commit)}
                    if commit is not None else None)
        with zipfile.ZipFile(archive_path) as package:
            seen, values = set(), {}
            for entry in package.infolist():
                name = entry.filename
                pure = PurePosixPath(name)
                if (name in seen or entry.is_dir() or pure.is_absolute() or '\\' in name or
                        any(part in ('', '.', '..') for part in pure.parts) or
                        not runtime_name(name) or
                        entry.flag_bits & 1 or stat.S_ISLNK(entry.external_attr >> 16) or
                        entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)):
                    raise common.Failure('portable_archive_entries_invalid')
                if expected is not None and (name not in expected or entry.file_size != len(expected[name][0])):
                    raise common.Failure('portable_bundle_source_mismatch')
                seen.add(name)
                values[name] = package.read(entry)
            required = {'node/main.mjs', 'php/worker.php', 'assets/release-public.der',
                        'VERSION.json', 'update-sources.example.json'}
            if not required <= seen:
                raise common.Failure('portable_runtime_files_missing')
            if json.loads(values['VERSION.json']) != expected_version:
                raise common.Failure('portable_bundle_version_mismatch')
            if values['assets/release-public.der'] != (root / 'assets/release-public.der').read_bytes():
                raise common.Failure('portable_bundle_public_key_mismatch')
            if values['update-sources.example.json'] != (root / 'update-sources.example.json').read_bytes():
                raise common.Failure('portable_bundle_sources_template_mismatch')
            check_sources_template(values['update-sources.example.json'])
            if expected is not None:
                if set(expected) != seen or any(values[name] != expected[name][0] for name in seen):
                    raise common.Failure('portable_bundle_source_mismatch')
                for entry in package.infolist():
                    if stat.S_IMODE(entry.external_attr >> 16) != expected[entry.filename][1]:
                        raise common.Failure('portable_bundle_source_mode_mismatch')
            secrets = [value.encode() for key, value in env.items() if len(value) >= 8 and
                       re.search(r'token|password|secret|private_key|release_sources|database_url|amqp_url', key, re.I)]
            for data in values.values():
                if b'-----BEGIN PRIVATE KEY-----' in data or b'-----BEGIN RSA PRIVATE KEY-----' in data or any(value in data for value in secrets):
                    raise common.Failure('portable_private_value_in_archive')
            return {'files': len(seen), 'length': Path(archive_path).stat().st_size,
                    'sha256': common.sha(Path(archive_path).read_bytes())}
    except (OSError, ValueError, KeyError, TypeError, UnicodeError, RuntimeError, zipfile.BadZipFile):
        raise common.Failure('portable_archive_invalid') from None


def runtime_tests(root, tag):
    env = dict(os.environ)
    for key in list(env):
        if re.search(r'token|password|secret|private_key|release_sources|database_url|amqp_url', key, re.I) or key in ('FLEET_SIGNING_DIRECTORY', 'GNUPGHOME'):
            env.pop(key, None)
    tests = sorted(str(path.relative_to(root)) for path in (root / 'tests').glob('*.test.mjs'))
    if not {'tests/node.test.mjs', 'tests/php.test.mjs'} <= set(tests):
        raise common.Failure('portable_runtime_test_suites_missing')
    process = subprocess.run(['node', '--test', '--test-reporter=tap', *tests],
                             cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    output = common.sanitize_output(process.stdout + process.stderr, os.environ)
    common.save(root / 'dist' / ('test-results-' + tag + '.log'), output.encode())
    counts = {name: re.findall(r'^# ' + name + r' ([0-9]+)\s*$', output, re.M)
              for name in ('tests', 'pass', 'fail', 'cancelled', 'skipped')}
    if (process.returncode or any(not count for count in counts.values()) or
            int(counts['tests'][-1]) <= 0 or counts['tests'][-1] != counts['pass'][-1] or
            any(int(counts[name][-1]) for name in ('fail', 'cancelled', 'skipped'))):
        print(output, flush=True)
        raise common.Failure('portable_runtime_tests_failed_or_skipped')
    print('Portable runtime tests: ' + counts['pass'][-1] + ' passed', flush=True)


def unsigned(root, tag, commit):
    current = version(root, tag)
    # Test the exact clean checkout; ignored dist files do not affect this check.
    common.run(['git', 'diff', '--exit-code', commit, '--'], cwd=root)
    runtime_tests(root, tag)
    entries = runtime_entries(root, commit)
    out = root / 'dist/unsigned'
    out.mkdir(parents=True, exist_ok=True)
    archive_path = out / ARCHIVE
    common.archive(archive_path, entries, 0, zip_format=True)
    inspected = inspect_archive(root, archive_path, current, commit=commit)
    common.save(out / 'build.json', common.json_bytes({'tag': tag, 'commit': commit, 'version': current, **inspected}))
    return inspected


def verify_portable(root, out, config, tag, commit):
    if config['component'] != COMPONENT:
        raise common.Failure('portable_component_required')
    current = version(root, tag)
    try:
        manifest = json.loads((out / MANIFEST).read_bytes())
        if set(manifest) != set(FIELDS) | {'signature_alg', 'signature'}:
            raise common.Failure('portable_manifest_fields_invalid')
        if ((manifest['component'], manifest['version_code'], manifest['version_name']) !=
                (COMPONENT, current['code'], current['name']) or type(manifest['version_code']) is not int):
            raise common.Failure('portable_manifest_identity')
        if manifest['signature_alg'] != 'SHA256withRSA' or manifest['url'] != canonical_url(tag):
            raise common.Failure('portable_manifest_signature_or_url')
        if not common.HEX.fullmatch(manifest['sha256']) or common.sha((out / ARCHIVE).read_bytes()) != manifest['sha256']:
            raise common.Failure('portable_archive_hash')
        inspect_archive(root, out / ARCHIVE, current, commit=commit)
        signature = base64.b64decode(manifest['signature'], validate=True)
        with tempfile.TemporaryDirectory(prefix='portable-signature-') as tmp:
            signature_file = Path(tmp) / 'signature.bin'
            signature_file.write_bytes(signature)
            common.run(['openssl', 'dgst', '-sha256', '-verify', root / 'assets/release-public.der',
                        '-keyform', 'DER', '-signature', signature_file], data=signature_bytes(manifest))
        return manifest
    except (OSError, ValueError, KeyError, TypeError):
        raise common.Failure('portable_manifest_invalid') from None


def build(root, out, config, tag, commit):
    current = version(root, tag)
    incoming = root / 'dist/unsigned'
    try:
        metadata = json.loads((incoming / 'build.json').read_bytes())
        archive = incoming / ARCHIVE
        if ((metadata['tag'], metadata['commit'], metadata['version'], metadata['sha256'], metadata['length']) !=
                (tag, commit, current, common.sha(archive.read_bytes()), archive.stat().st_size)):
            raise common.Failure('portable_unsigned_identity_mismatch')
    except (OSError, ValueError, KeyError, TypeError):
        raise common.Failure('portable_unsigned_build_required') from None
    inspect_archive(root, archive, current, commit=commit)
    common.save(out / ARCHIVE, archive.read_bytes())
    manifest = {'component': COMPONENT, 'version_code': current['code'], 'version_name': current['name'],
                'url': canonical_url(tag), 'sha256': common.sha(archive.read_bytes()), 'signature_alg': 'SHA256withRSA'}
    private = Path(common.required('FLEET_SIGNING_DIRECTORY')) / 'release-signing.pem'
    signature = common.run(['openssl', 'dgst', '-sha256', '-sign', private], data=signature_bytes(manifest))
    manifest['signature'] = base64.b64encode(signature).decode()
    common.save(out / MANIFEST, common.json_bytes(manifest))
    verify_portable(root, out, config, tag, commit)
    common.finish_record(out, COMPONENT, tag, commit)
    return verify_release(root, out, config, tag, commit)


def verify_release(root, out, config, tag, commit):
    record = common.verify_record(out, COMPONENT, tag, commit)
    if {item['name'] for item in record['files']} != {ARCHIVE, MANIFEST}:
        raise common.Failure('portable_canonical_asset_set')
    verify_portable(root, out, config, tag, commit)
    return record


def fetch_canonical(remote, root, out, config, tag, commit):
    record = common.fetch_canonical(remote, root, out, config, tag, commit)
    if {item['name'] for item in record['files']} != {ARCHIVE, MANIFEST}:
        raise common.Failure('portable_canonical_asset_set')
    verify_portable(root, out, config, tag, commit)
    return record


def channel_documents(config, record, manifest, archive_url):
    parsed = urllib.parse.urlsplit(archive_url)
    if parsed.scheme != 'https' or parsed.hostname != 'gitflic.ru' or parsed.username:
        raise common.Failure('portable_public_gitflic_archive_link_missing')
    base = 'https://gitflic.ru/project/' + common.encoded(config['gitflic_owner']) + '/' + common.encoded(config['gitflic_project']) + '/blob/raw?'
    channel = {'tag': record['tag'], 'version_code': manifest['version_code'], 'source_commit': record['commit'],
               'sha256': manifest['sha256'], 'archive_url': archive_url}
    paths = {}
    for field, name in (('manifest_url', MANIFEST), ('canonical_record_url', 'release-record.json')):
        relative = 'releases/' + record['tag'] + '/' + name
        paths[field] = relative
        channel[field] = base + urllib.parse.urlencode({'file': relative, 'commit': 'release-channel'})
    return channel, paths


def publish_channel(root, remote, record, config):
    public = common.GitFlicWeb(config['gitflic_owner'] + '/' + config['gitflic_project'])
    out = root / 'dist' / record['tag']
    fetch_canonical(public, root, out, config, record['tag'], record['commit'])
    release = public.release(record['tag'])
    if release is None:
        raise common.Pending('public_channel_release_pending')
    assets = [asset for asset in public.assets(release) if asset['name'] == ARCHIVE]
    if len(assets) != 1:
        raise common.Failure('portable_public_gitflic_archive_link_missing')
    manifest = json.loads((out / MANIFEST).read_bytes())
    channel, paths = channel_documents(config, record, manifest, assets[0].get('link', ''))
    files = {relative: (out / relative.rsplit('/', 1)[1]).read_bytes() for relative in paths.values()}
    with tempfile.TemporaryDirectory(prefix='portable-channel-') as tmp:
        tmp = Path(tmp)
        home = tmp / 'gnupg'
        home.mkdir(mode=0o700)
        env = dict(os.environ, GNUPGHOME=str(home), GIT_TERMINAL_PROMPT='0')
        common.run(['gpg', '--batch', '--import', Path(common.required('FLEET_GPG_PRIVATE_KEY_FILE'))], env=env)
        keys = common.run(['gpg', '--batch', '--with-colons', '--list-secret-keys'], env=env).decode()
        fingerprints = [line.split(':')[9] for line in keys.splitlines() if line.startswith('fpr:')]
        if not fingerprints:
            raise common.Failure('ci_git_signing_key_missing')
        ask = tmp / 'askpass.py'
        common.save(ask, b'#!/usr/bin/env python3\nimport os,sys\nprint(os.environ.get("FLEET_GITFLIC_USERNAME","token") if "username" in sys.argv[1].lower() else os.environ["GITFLIC_TOKEN"])\n')
        ask.chmod(0o700)
        env['GIT_ASKPASS'] = str(ask)
        clone = tmp / 'repo'
        clone.mkdir()
        address = os.environ.get('FLEET_CHANNEL_REMOTE', 'https://gitflic.ru/project/' + config['gitflic_owner'] + '/' + config['gitflic_project'] + '.git')
        parsed = urllib.parse.urlsplit(address)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.query or parsed.fragment:
            raise common.Failure('channel_remote_https_without_credentials_required')
        def git(*args):
            return common.run(['git', *args], cwd=clone, env=env)
        git('init', '-q')
        git('config', 'user.name', 'DistributedWorkersReleaseBot')
        git('config', 'user.email', os.environ.get('FLEET_RELEASE_BOT_EMAIL', '14372308+hawkab@users.noreply.github.com'))
        git('config', 'user.signingkey', fingerprints[0])
        refs = git('ls-remote', '--heads', address, 'release-channel')
        if refs.strip():
            git('fetch', '--depth=1', address, 'refs/heads/release-channel')
            git('checkout', '-q', '-b', 'release-channel', 'FETCH_HEAD')
            stable = clone / 'stable.json'
            if stable.is_file():
                previous = json.loads(stable.read_bytes())
                if previous.get('version_code', 0) > channel['version_code']:
                    return
                if previous.get('version_code') == channel['version_code']:
                    if previous.get('sha256') != channel['sha256']:
                        raise common.Failure('channel_same_version_hash_conflict')
                    if previous == channel:
                        common.verify_channel_metadata(channel, paths, files)
                        return
        else:
            git('checkout', '--orphan', 'release-channel')
        for relative, data in files.items():
            target = clone / relative
            if target.exists() and target.read_bytes() != data:
                raise common.Failure('immutable_channel_metadata_conflict')
            common.save(target, data)
        common.save(clone / 'stable.json', common.json_bytes(channel))
        git('add', '--', 'stable.json', *sorted(files))
        git('commit', '-S', '-m', 'Release ' + record['tag'])
        pushed = subprocess.run(['git', 'push', address, 'HEAD:refs/heads/release-channel'], cwd=clone, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if pushed.returncode:
            error = pushed.stderr.decode(errors='replace').lower()
            if any(word in error for word in ('authentication failed', 'permission denied', 'access denied', '403', 'not allowed')):
                raise common.Failure('channel_push_permission_denied')
            if any(word in error for word in ('non-fast-forward', 'fetch first', 'could not resolve', 'connection', 'timeout', 'remote end hung up')):
                raise common.Temporary('channel_push_reconcile')
            raise common.Failure('channel_push_failed')
        common.verify_channel_metadata(channel, paths, files)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=('unsigned', 'release', 'build', 'verify', 'publish'))
    parser.add_argument('--provider', choices=('gitflic', 'gitea', 'github'), default='gitflic')
    parser.add_argument('--tag', default=os.environ.get('FLEET_RELEASE_TAG', os.environ.get('CI_COMMIT_TAG', os.environ.get('GITHUB_REF_NAME', ''))))
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args(argv)
    root = Path(__file__).resolve().parent.parent
    config = json.loads((root / 'ci/component.json').read_bytes())
    if config['component'] != COMPONENT:
        raise common.Failure('portable_component_required')
    version(root, args.tag)
    commit = common.run(['git', 'rev-parse', 'HEAD'], cwd=root).decode().strip()
    pinned = common.run(['git', 'rev-parse', args.tag + '^{commit}'], cwd=root).decode().strip()
    if commit != pinned:
        raise common.Failure('checkout_does_not_match_release_tag')
    out = root / 'dist' / args.tag
    out.mkdir(parents=True, exist_ok=True)
    if args.command == 'unsigned':
        if args.provider != 'gitflic':
            raise common.Failure('canonical_portable_build_only')
        unsigned(root, args.tag, commit)
        return
    if args.command == 'verify':
        verify_release(root, out, config, args.tag, commit)
        print(json.dumps({'verified': True, 'component': COMPONENT, 'tag': args.tag}))
        return
    if args.command == 'build':
        if args.provider != 'gitflic':
            raise common.Failure('canonical_build_only')
        build(root, out, config, args.tag, commit)
        return
    remote = common.forge(args.provider, config)
    canonical = common.forge('gitflic', config, canonical=True)
    def operation():
        if args.command == 'publish':
            record = verify_release(root, out, config, args.tag, commit)
        elif args.provider != 'gitflic':
            record = fetch_canonical(canonical, root, out, config, args.tag, commit)
        else:
            existing = remote.release(args.tag)
            ready = existing and any(asset['name'] in ('release-record.json', common.METADATA_ZIP) for asset in remote.assets(existing))
            if ready:
                record = fetch_canonical(remote, root, out, config, args.tag, commit)
            elif (out / 'release-record.json').is_file():
                record = verify_release(root, out, config, args.tag, commit)
            else:
                record = build(root, out, config, args.tag, commit)
        result = common.publish(remote, out, record)
        if args.provider == 'gitflic':
            publish_channel(root, remote, record, config)
            result['channel_published'] = True
        return result
    print(json.dumps(common.retry(operation, out / 'release-state.json', once=args.once), sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except common.Temporary as error:
        print('release pending: ' + str(error), file=sys.stderr)
        sys.exit(75)
    except common.Failure as error:
        print('release failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
