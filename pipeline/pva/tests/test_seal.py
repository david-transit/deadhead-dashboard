import datetime as dt, json, os, shutil, subprocess, tempfile, unittest
from pva import seal

OP = 'derech-egged'
POLICY = {"procedure_from": "2026-11-22", "not_blind_through": "2026-11-21", "locked": ["2026-11-01", "2026-11-16"]}


def git(cwd, *a):
    subprocess.run(['git', '-C', cwd, *a], check=True, capture_output=True)


class TestSeal(unittest.TestCase):
    """A throw-away repo with its own 'GitHub' (a bare remote), so seal/commit/push/verify run for real."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.remote, self.root = os.path.join(self.tmp, 'remote.git'), os.path.join(self.tmp, 'repo')
        git(self.tmp, 'init', '-q', '--bare', self.remote)
        git(self.tmp, 'clone', '-q', self.remote, self.root)
        for k, v in (('user.name', 'test'), ('user.email', 'test@example.invalid'), ('core.autocrlf', 'false')):
            git(self.root, 'config', k, v)
        os.makedirs(os.path.join(self.root, 'seals')); os.makedirs(os.path.join(self.root, 'data', OP))
        json.dump(POLICY, open(os.path.join(self.root, 'seals', 'policy.json'), 'w'))
        for d in ('2026-11-23', '2026-11-24', '2026-11-25', '2026-11-20', '2026-11-10'):
            self.day_file(d, 'encrypted ' + d)
        git(self.root, 'add', '-A'); git(self.root, 'commit', '-q', '-m', 'init'); git(self.root, 'branch', '-M', 'main'); git(self.root, 'push', '-q', '-u', 'origin', 'main')

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def day_file(self, d, text):
        open(os.path.join(self.root, 'data', OP, f'day_{d}.js'), 'w').write(text)

    def later(self):
        return dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=5)

    def test_valid_seal_is_blind(self):
        new = seal.seal_days(['2026-11-23'], OP, root=self.root)
        self.assertEqual(len(new), 1)
        self.assertEqual(new, ['derech-egged/2026-11-23.json'])
        # the seal is on the remote ("GitHub"), on the seals branch only, and holds hashes only
        out = subprocess.run(['git', '--git-dir', self.remote, 'log', '--format=%s', 'seals'], capture_output=True, text=True).stdout
        self.assertIn('seal: derech-egged 2026-11-23', out)
        rec = json.loads(subprocess.run(['git', '--git-dir', self.remote, 'show', 'seals:derech-egged/2026-11-23.json'],
                                        capture_output=True, text=True, encoding='utf-8').stdout)
        self.assertEqual(set(rec), {'day', 'operator', 'sealed_at', 'files'})
        self.assertEqual(len(rec['files'][0]['sha256']), 64)
        main = subprocess.run(['git', '--git-dir', self.remote, 'log', '--format=%s', 'main'], capture_output=True, text=True).stdout
        self.assertNotIn('seal:', main)
        # a second day goes on top of the existing seals branch; an existing seal is never rewritten
        self.assertEqual(seal.seal_days(['2026-11-24'], OP, root=self.root), ['derech-egged/2026-11-24.json'])
        self.assertEqual(seal.seal_days(['2026-11-23'], OP, root=self.root), [])
        v = seal.verify('2026-11-23', OP, self.later(), root=self.root)
        self.assertTrue(v['blind'], v['why'])
        self.assertTrue(seal.gate_a_eligible({'blind': v['blind']}))

    def test_no_seal_is_not_blind(self):
        v = seal.verify('2026-11-24', OP, self.later(), root=self.root)
        self.assertFalse(v['blind']); self.assertIn('אין חתימה', v['why'])
        self.assertFalse(seal.gate_a_eligible({'blind': v['blind']}))

    def test_changed_reconstruction_is_not_blind(self):
        seal.seal_days(['2026-11-25'], OP, root=self.root)
        self.day_file('2026-11-25', 'rebuilt after looking at the operator file')
        v = seal.verify('2026-11-25', OP, self.later(), root=self.root)
        self.assertFalse(v['blind']); self.assertIn('שונה מהחתימה', v['why'])

    def test_seal_later_than_opening_is_not_blind(self):
        opened = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=1)
        seal.seal_days(['2026-11-23'], OP, root=self.root)
        v = seal.verify('2026-11-23', OP, opened, root=self.root)
        self.assertFalse(v['blind']); self.assertIn('מאוחרת', v['why'])

    def test_day_read_before_procedure_is_not_blind(self):
        seal.seal_days(['2026-11-20'], OP, root=self.root)
        v = seal.verify('2026-11-20', OP, self.later(), root=self.root)
        self.assertFalse(v['blind']); self.assertIn('לפני 22.11', v['why'])

    def test_locked_period_refused_before_opening(self):
        with self.assertRaises(seal.SealError):
            seal.seal_days(['2026-11-10'], OP, root=self.root)
        out = subprocess.run(['git', '--git-dir', self.remote, 'branch', '--list', 'seals'], capture_output=True, text=True).stdout
        self.assertEqual(out.strip(), '')

    def test_missing_reconstruction_refused(self):
        with self.assertRaises(seal.SealError):
            seal.seal_days(['2026-11-30'], OP, root=self.root)

    def test_old_payload_without_field_not_in_gate_a(self):
        self.assertFalse(seal.gate_a_eligible({'day': '2026-11-10'}))


if __name__ == '__main__':
    unittest.main()
