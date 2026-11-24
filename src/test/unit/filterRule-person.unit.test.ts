import * as assert from 'assert';
import { buildPeople, isAgentIdentity, makeContext, parseIdent } from '../../core/filter';
import { person } from '../../core/filter/rules/person';
import { found, findsNothing, j, rewritten, run } from './filterHarness';

const PERSON_NAME = j('Robin', ' Exampleton');
const PERSON_EMAIL = j('robin', '@', 'example.org');
const LOGIN = j('rex', 'ampleton');
const LOGIN_EMAIL = j('12345+', LOGIN, '@users.noreply.github.com');
const OTHER_EMAIL = j('someone.else', '@', 'mail.example.net');
const people = [`${PERSON_NAME} <${PERSON_EMAIL}>`, `${LOGIN} <${LOGIN_EMAIL}>`, 'Claude Opus 5.5 <noreply@anthropic.com>'];

run([
  ['every form of a person is the one value, their name: ident, name, email, login, @mention', () => {
    const text = `${PERSON_NAME} <${PERSON_EMAIL}> wrote; mail ${PERSON_EMAIL}; ${PERSON_NAME.toUpperCase()} said @${LOGIN} should look`;
    assert.deepStrictEqual(found(person, text, { people }).map(([, v]) => v), [PERSON_NAME, PERSON_NAME, PERSON_NAME, LOGIN]);
    assert.strictEqual(rewritten(text, { people }, [person]), '[person-1] wrote; mail [person-1]; [person-1] said @[person-2] should look');
  }],
  ['Co-Authored-By trailers: a person becomes [person-N]; an agent is no person', () => {
    const body = `Fix\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nCo-Authored-By: ${LOGIN} <${LOGIN_EMAIL}>`;
    assert.strictEqual(rewritten(body, { people }, [person]), 'Fix\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nCo-Authored-By: [person-1]');
  }],
  ['a bd actor by name, a bare owner email and a login join the git ident they match', () => {
    const ps = buildPeople([PERSON_NAME, PERSON_EMAIL, `${PERSON_NAME} <${PERSON_EMAIL}>`, LOGIN, `${LOGIN} <${LOGIN_EMAIL}>`, OTHER_EMAIL, 'claude-code']);
    assert.strictEqual(ps.length, 3, JSON.stringify(ps));
    const ctx = makeContext({ people: [PERSON_EMAIL, `${PERSON_NAME} <${PERSON_EMAIL}>`] });
    assert.strictEqual(ctx.personByForm.get(PERSON_EMAIL)!.display, PERSON_NAME, 'the bare email is the ident\'s person');
    // A login names the noreply email's person, even when the ident's name differs.
    const ctx2 = makeContext({ people: [LOGIN, `Rex Ample <${LOGIN_EMAIL}>`] });
    assert.strictEqual(ctx2.people.length, 1);
    assert.strictEqual(ctx2.personByForm.get(LOGIN)!.display, 'Rex Ample');
  }],
  ['agents are not people', () => {
    assert.ok(isAgentIdentity('Copilot', '175728472+Copilot@users.noreply.github.com'));
    assert.ok(isAgentIdentity('dependabot[bot]', '49699333+dependabot[bot]@users.noreply.github.com'));
    assert.ok(isAgentIdentity('dependabot[bot]', 'support@github.com'), "a [bot] name is an app's, whatever the email");
    assert.ok(isAgentIdentity('claude-code', undefined));
    assert.ok(!isAgentIdentity('Claude Person', 'claude.person@example.com'), 'a human named Claude is a person');
    assert.deepStrictEqual(buildPeople(['claude-code', 'Claude Opus 5.5 <noreply@anthropic.com>', 'my-agent'], ['my-agent']), []);
    assert.deepStrictEqual(parseIdent(PERSON_EMAIL), { name: '', email: PERSON_EMAIL });
  }],
  ['only the people the records name, as whole words', () => {
    findsNothing(person, [`@stranger-dev and ${OTHER_EMAIL}`, `Robinson ${LOGIN}s`], { people });
    findsNothing(person, ['anything'], {});
  }],
]);
