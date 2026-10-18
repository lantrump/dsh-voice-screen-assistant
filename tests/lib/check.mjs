// 极简断言器，所有测试共用。输出 PASS/FAIL，结束时设置退出码。
export function createChecker() {
  let pass = 0, fail = 0;

  const eq = (name, got, want) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; console.log('PASS  ' + name); }
    else { fail++; console.log(`FAIL  ${name}\n        got  ${g}\n        want ${w}`); }
  };

  const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log('PASS  ' + name); }
    else { fail++; console.log(`FAIL  ${name}${detail ? '\n        ' + detail : ''}`); }
  };

  const throws = async (name, fn, frag) => {
    try { await fn(); fail++; console.log(`FAIL  ${name}（本该报错却通过了）`); }
    catch (e) {
      if (!frag || String(e.message).includes(frag)) { pass++; console.log('PASS  ' + name); }
      else { fail++; console.log(`FAIL  ${name}\n        报错是「${e.message}」，期望含「${frag}」`); }
    }
  };

  const section = (t) => console.log('\n--- ' + t + ' ---');

  const done = () => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
    return fail === 0;
  };

  return { eq, ok, throws, section, done };
}
