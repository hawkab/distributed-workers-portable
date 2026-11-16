import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

CI = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CI))
spec = importlib.util.spec_from_file_location('portable_release', CI / 'portable_release.py')
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)
c = p.common


def command(argv, cwd=None):
    return subprocess.run([str(x) for x in argv], cwd=cwd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout


class MemoryForge:
    provider = 'gitflic'
    def __init__(self): self.saved = None; self.data = {}; self.uploads = []
    def release(self, tag): return self.saved
    def assets(self, release): return [{'name': name} for name in self.data]
    def create(self, record):
        self.saved = {'commitId': record['commit'], 'description': 'fleet-release:worker-portable:' + record['tag'] + ':' + record['commit']}
        return self.saved
    def upload(self, release, path): self.uploads.append(path.name); self.data[path.name] = path.read_bytes()
    def download(self, release, asset): return self.data[asset['name']]


class PortableTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.keys = tempfile.TemporaryDirectory(); cls.private = Path(cls.keys.name) / 'release-signing.pem'
        command(['openssl', 'genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', cls.private])
        cls.public = command(['openssl', 'pkey', '-in', cls.private, '-pubout', '-outform', 'DER'])
    @classmethod
    def tearDownClass(cls): cls.keys.cleanup()
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup); self.root = Path(self.tmp.name)
        self.version = {'code': 1, 'name': '0.4.0'}
        self.config = {'component': 'worker-portable', 'gitflic_owner': 'distributed-workers', 'gitflic_project': 'worker-portable'}
        sources = [{'id': 'gitea', 'url': 'https://gitea.invalid/manifest.json'}, {'id': 'gitflic', 'url': 'https://gitflic.ru/project/distributed-workers/worker-portable/blob/raw?file=stable.json&commit=release-channel'}, {'id': 'github', 'url': 'https://github.com/hawkab/distributed-workers-portable/releases/latest/download/portable-manifest.json'}]
        self.files = {'node/main.mjs': b'export const fixture = true;\n', 'php/worker.php': b'<?php echo "fixture";\n', 'assets/release-public.der': self.public, 'VERSION.json': c.json_bytes(self.version), 'ci/version.json': c.json_bytes(self.version), 'update-sources.example.json': c.json_bytes(sources), 'tests/node.test.mjs': b'//fixture\n', 'tests/php.test.mjs': b'//fixture\n', 'README.md': b'Portable runtime fixture\n'}
        for name, data in self.files.items():
            target = self.root / name; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data)
        command(['git', 'init', '-q'], self.root); command(['git', 'add', '.'], self.root)
        command(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-q', '-m', 'fixture'], self.root)
        self.commit = command(['git', 'rev-parse', 'HEAD'], self.root).decode().strip()
        self.out = self.root / 'dist/v0.4.0'; self.out.mkdir(parents=True)
    def make_unsigned(self):
        target = self.root / 'dist/unsigned'; target.mkdir(parents=True, exist_ok=True); archive = target / p.ARCHIVE
        c.archive(archive, p.runtime_entries(self.root, self.commit), 0, zip_format=True)
        proof = p.inspect_archive(self.root, archive, self.version, commit=self.commit)
        c.save(target / 'build.json', c.json_bytes({'tag': 'v0.4.0', 'commit': self.commit, 'version': self.version, **proof}))
        return archive
    def signed(self):
        self.make_unsigned()
        with patch.dict(os.environ, {'FLEET_SIGNING_DIRECTORY': self.keys.name}): return p.build(self.root, self.out, self.config, 'v0.4.0', self.commit)

    def test_five_field_signature_bytes_end_newline(self):
        m = dict(component='worker-portable', version_code=1, version_name='0.4.0', url='https://example.invalid/a', sha256='a' * 64)
        self.assertEqual(('worker-portable\n1\n0.4.0\nhttps://example.invalid/a\n' + 'a' * 64 + '\n').encode(), p.signature_bytes(m))

    def test_native_gitea_latest_api_template_is_supported(self):
        sources = json.loads(self.files['update-sources.example.json'])
        sources[0] = {'id': 'gitea', 'kind': 'gitea', 'url': 'https://gitea.invalid/api/v1/repos/distributed-workers/worker-portable/releases/latest'}
        p.check_sources_template(c.json_bytes(sources))
        sources[0]['url'] = 'https://gitea.invalid/releases/latest/download/portable-manifest.json'
        with self.assertRaises(c.Failure): p.check_sources_template(c.json_bytes(sources))

    def test_tag_and_integer_validation(self):
        self.assertEqual(self.version, p.version(self.root, 'v0.4.0'))
        with self.assertRaises(c.Failure): p.version(self.root, 'v0.4.1')
        (self.root / 'ci/version.json').write_text('{"code":true,"name":"0.4.0"}')
        with self.assertRaises(c.Failure): p.version(self.root, 'v0.4.0')

    def test_immutable_blobs_exclude_local_state_and_tests(self):
        (self.root / 'node/main.mjs').write_bytes(b'local changed bytes')
        (self.root / 'node/config.local.json').write_bytes(b'private state')
        values = {name: data for name, data, mode in p.runtime_entries(self.root, self.commit)}
        self.assertEqual(self.files['node/main.mjs'], values['node/main.mjs'])
        self.assertNotIn('node/config.local.json', values); self.assertNotIn('tests/php.test.mjs', values)

    def test_zip_reproducible_and_fixed_timestamps(self):
        first = self.make_unsigned().read_bytes(); self.assertEqual(first, self.make_unsigned().read_bytes())
        with zipfile.ZipFile(io.BytesIO(first)) as z: self.assertTrue(all(x.date_time == (1980, 1, 1, 0, 0, 0) for x in z.infolist()))

    def test_signer_does_not_execute_runtime(self):
        with patch.object(p, 'runtime_tests', side_effect=AssertionError('never execute in signer')): record = self.signed()
        self.assertEqual({p.ARCHIVE, p.MANIFEST}, {x['name'] for x in record['files']})
        p.verify_portable(self.root, self.out, self.config, 'v0.4.0', self.commit)

    def test_tampered_unsigned_source_rejected_even_with_rehashed_metadata(self):
        archive = self.make_unsigned()
        entries = [(name, b'changed!' if name == 'node/main.mjs' else data, mode) for name, data, mode in p.runtime_entries(self.root, self.commit)]
        c.archive(archive, entries, 0, zip_format=True)
        metadata = json.loads((archive.parent / 'build.json').read_bytes()); metadata.update(sha256=c.sha(archive.read_bytes()), length=archive.stat().st_size)
        (archive.parent / 'build.json').write_bytes(c.json_bytes(metadata))
        with self.assertRaisesRegex(c.Failure, 'portable_bundle_source_mismatch'): p.build(self.root, self.out, self.config, 'v0.4.0', self.commit)

    def test_bad_signature_and_noncanonical_url_rejected(self):
        self.signed(); target = self.out / p.MANIFEST; original = json.loads(target.read_bytes())
        for patch_value in ({'signature': base64.b64encode(b'wrong').decode()}, {'url': 'https://private.invalid/zip'}):
            target.write_bytes(c.json_bytes(dict(original, **patch_value)))
            with self.assertRaises(c.Failure): p.verify_portable(self.root, self.out, self.config, 'v0.4.0', self.commit)

    def test_known_secret_and_private_template_rejected(self):
        archive = self.make_unsigned()
        entries = [(name, b'fixture-secret-value' if name == 'README.md' else data, mode) for name, data, mode in p.runtime_entries(self.root, self.commit)]
        c.archive(archive, entries, 0, zip_format=True)
        with self.assertRaisesRegex(c.Failure, 'private_value'): p.inspect_archive(self.root, archive, self.version, environment={'GITHUB_TOKEN': 'fixture-secret-value'})
        raw = self.files['update-sources.example.json']
        for bad in (raw.replace(b'gitea.invalid', b'private.invalid'), raw.replace(b'commit=release-channel', b'branch=release-channel')):
            with self.assertRaises(c.Failure): p.check_sources_template(bad)

    def test_default_template_cannot_hide_unknown_credential_fields(self):
        sources = json.loads(self.files['update-sources.example.json'])
        sources[1]['token'] = 'accidentally-committed-value'
        with self.assertRaises(c.Failure): p.check_sources_template(c.json_bytes(sources))
        sources = json.loads(self.files['update-sources.example.json'])
        sources[1]['url'] += '&token=accidentally-committed-value'
        with self.assertRaises(c.Failure): p.check_sources_template(c.json_bytes(sources))

    def test_traversal_symlink_and_duplicate_zip_members_rejected(self):
        for name, mode in (('../outside', stat.S_IFREG | 0o644), ('node/link.mjs', stat.S_IFLNK | 0o777), ('node/main.mjs', stat.S_IFREG | 0o644)):
            archive = self.make_unsigned()
            with zipfile.ZipFile(archive, 'a') as z:
                entry = zipfile.ZipInfo(name); entry.external_attr = mode << 16; z.writestr(entry, b'bad')
            with self.assertRaises(c.Failure): p.inspect_archive(self.root, archive, self.version)

    def test_canonical_rsa_verified_before_mirror_publish_and_metadata_last(self):
        record = self.signed(); remote = MemoryForge(); c.publish(remote, self.out, record)
        self.assertEqual([p.ARCHIVE, c.METADATA_ZIP], remote.uploads)
        c.publish(remote, self.out, record); self.assertEqual(2, len(remote.uploads))
        target = self.root / 'mirror'; target.mkdir()
        self.assertEqual(record, p.fetch_canonical(remote, self.root, target, self.config, 'v0.4.0', self.commit))
        m = json.loads((self.out / p.MANIFEST).read_bytes()); m['signature'] = base64.b64encode(b'bad').decode()
        (self.out / p.MANIFEST).write_bytes(c.json_bytes(m)); bad_record = c.finish_record(self.out, 'worker-portable', 'v0.4.0', self.commit)
        bad = MemoryForge(); c.publish(bad, self.out, bad_record)
        with self.assertRaises(c.Failure): p.fetch_canonical(bad, self.root, target, self.config, 'v0.4.0', self.commit)

    def test_unexpected_release_file_cannot_be_published_on_resume(self):
        self.signed()
        (self.out / 'unexpected.json').write_text('{"private":"fixture"}')
        c.finish_record(self.out, 'worker-portable', 'v0.4.0', self.commit)
        with self.assertRaisesRegex(c.Failure, 'portable_canonical_asset_set'):
            p.verify_release(self.root, self.out, self.config, 'v0.4.0', self.commit)

    def test_channel_archive_and_commit_selector_contract(self):
        record = self.signed(); m = json.loads((self.out / p.MANIFEST).read_bytes())
        channel, paths = p.channel_documents(self.config, record, m, 'https://gitflic.ru/project/distributed-workers/worker-portable/release/download/fixture')
        self.assertIn('archive_url', channel); self.assertNotIn('apk_url', channel)
        for key in paths: self.assertIn('commit=release-channel', channel[key]); self.assertNotIn('branch=', channel[key])

    def test_runtime_skips_fail_and_credentials_not_in_child(self):
        valid = b'# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n'
        with patch.dict(os.environ, {'GITFLIC_TOKEN': 'fixture-secret-value', 'FLEET_SIGNING_DIRECTORY': '/private/fixture'}):
            with patch.object(p.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, valid, b'')) as invoked: p.runtime_tests(self.root, 'v0.4.0')
        env = invoked.call_args.kwargs['env']; self.assertNotIn('GITFLIC_TOKEN', env); self.assertNotIn('FLEET_SIGNING_DIRECTORY', env)
        invalid = valid.replace(b'# pass 2', b'# pass 1').replace(b'# skipped 0', b'# skipped 1')
        with patch.object(p.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, invalid, b'')), self.assertRaises(c.Failure): p.runtime_tests(self.root, 'v0.4.0')


class WorkflowTests(unittest.TestCase):
    def test_signer_only_validates_and_signs_unsigned_artifact(self):
        text = (CI.parent / 'gitflic-ci.yaml').read_text(); signer = text.split('portable_sign_release:', 1)[1]
        self.assertIn('needs: [portable_unsigned]', signer); self.assertNotIn('node --test', signer)
        self.assertNotIn('portable_release.py unsigned', signer); self.assertNotIn('/var/run/docker.sock', text)
    def test_mirrors_invoke_portable_verifier_without_private_keys(self):
        for provider in ('github', 'gitea'):
            text = (CI.parent / ('.' + provider) / 'workflows/release.yml').read_text()
            self.assertIn('ci/portable_release.py release --provider ' + provider, text)
            self.assertNotIn('sdkmanager', text); self.assertNotIn('release-signing.pem', text)


if __name__ == '__main__': unittest.main()
