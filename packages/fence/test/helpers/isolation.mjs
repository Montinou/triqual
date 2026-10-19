// Test isolation: how hard the tests and acceptance scripts keep away from the owner's real files.
//
// One knob, FENCE_TEST_ISOLATION (read on every call, so a test may set it before importing):
//
//   writes  (default)  Nothing writes outside temp directories. In-process engine and loader calls pin
//                      HOME (and USERPROFILE) to a temp home (withTempHome) and pass explicit --policy,
//                      --state-dir and --admin-dir; spawned children get the temp HOME (childEnv).
//                      Reads of normal system config (/etc/gitconfig, the real git global config) stay
//                      allowed, and the real uv package cache may be written (a download cache, not
//                      user data); `full` moves it to temp.
//   full               Also: children and in-process engines get a minimal environment (PATH, HOME,
//                      LANG=C, GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=/dev/null) instead of a copy
//                      of the caller's; the managed-settings paths are faked; the jev runners use a
//                      UV_CACHE_DIR under their temp root.
//   off                Only unlocks the manual real-host probe test/acceptance/cwd-probe/run.sh, which
//                      refuses to run at the other levels unless HOME (or CLAUDE_CONFIG_DIR) points
//                      inside a temp directory. At `off` it warns that it uses the real setup.
//
// An unknown value is an error naming the three levels.

export const LEVELS = ['writes', 'full', 'off'];

export function isolationLevel(env = process.env) {
  const raw = env.FENCE_TEST_ISOLATION;
  if (raw === undefined || raw === '') return 'writes';
  if (!LEVELS.includes(raw)) {
    throw new Error(`FENCE_TEST_ISOLATION=${JSON.stringify(raw)} is not a level; use one of: ${LEVELS.join(', ')}`);
  }
  return raw;
}

// The environment for a child process or an in-process engine run with HOME at `home`. FENCE_PROFILE is
// dropped (a caller that wants one passes it in `extra`).
export function childEnv(home, extra = {}) {
  const base =
    isolationLevel() === 'full'
      ? { PATH: process.env.PATH ?? '', HOME: home, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
      : { ...process.env, HOME: home };
  delete base.FENCE_PROFILE;
  return { ...base, ...extra };
}

// Runs `fn` with process.env.HOME and USERPROFILE (what os.homedir() reads) at `home`, then restores them.
export function withTempHome(home, fn) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
