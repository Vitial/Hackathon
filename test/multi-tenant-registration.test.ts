import { T, eq, rejects, fresh, NOW } from './helpers.ts';
import {
  installAuthSchema,
  requestTenantRegistration,
  approveTenantRegistration,
  rejectTenantRegistration,
  setTenantStatus,
  getTenant,
  isSlugAvailable,
  isReservedSlug,
  resolveTenantFromHost,
  tenantCanSignIn,
  claimTenantOwner,
  login,
  sessionUser,
  listTenantsByStatus,
} from '../src/core/auth.ts';
import { resolveRequestTenant } from '../src/console/serve.ts';

console.log('\n\x1b[1mMulti-tenant registration — subdomains, approval, paid-only gate\x1b[0m');

T('host resolution: subdomain selects org, central/reserved fall back', () => {
  eq(resolveTenantFromHost('acme.example.com', 'example.com', 'central'), 'acme');
  eq(resolveTenantFromHost('acme.example.com:3100', 'example.com', 'central'), 'acme');
  eq(resolveTenantFromHost('example.com', 'example.com', 'central'), 'central');
  eq(resolveTenantFromHost('www.example.com', 'example.com', 'central'), 'central');
  eq(resolveTenantFromHost('app.example.com', 'example.com', 'central'), 'central');
  eq(resolveTenantFromHost('api.example.com', 'example.com', 'central'), 'central');
  eq(resolveTenantFromHost('a.b.example.com', 'example.com', 'central'), 'central');
  eq(resolveTenantFromHost('example.com', null, 'central'), 'central');
  eq(resolveRequestTenant('globex.example.com', 'example.com', 'central'), 'globex');
  eq(resolveRequestTenant('example.com', 'example.com', 'central'), 'central');
});

T('reserved slugs can never be claimed', () => {
  eq(isReservedSlug('app'), true);
  eq(isReservedSlug('admin'), true);
  eq(isReservedSlug('acme-corp'), false);
});

T('registration creates pending tenant with no users and no sign-in', async () => {
  const ctx = await fresh();
  await installAuthSchema(ctx.db, NOW);
  const t = await requestTenantRegistration(
    ctx.db,
    { slug: 'globex', name: 'Globex Corp', email: 'ceo@globex.test', ownerName: 'Hank Scorpio', plan: 'growth' },
    NOW,
  );
  eq(t.status, 'pending_approval');
  eq(t.plan, 'growth');
  eq(tenantCanSignIn(t), false);
  const avail = await isSlugAvailable(ctx.db, 'globex');
  eq(avail.available, false);
  // No owner yet — claiming path still needs activation, and login has no user to check.
  await rejects(
    () => login(ctx.db, { tenant: 'globex', email: 'ceo@globex.test', password: 'x'.repeat(12) }, NOW),
    'auth:',
  );
});

T('approve -> activate -> claim owner -> login works', async () => {
  const ctx = await fresh();
  await installAuthSchema(ctx.db, NOW);
  await requestTenantRegistration(
    ctx.db,
    { slug: 'initech', name: 'Initech', email: 'peter@initech.test', ownerName: 'Peter Gibbons' },
    NOW,
  );
  const approved = await approveTenantRegistration(ctx.db, 'initech', { userId: 'op_1' }, NOW);
  eq(approved.status, 'approved_pending_payment');
  eq(tenantCanSignIn(approved), false);
  const active = await setTenantStatus(ctx.db, 'initech', 'active', { userId: 'op_1' }, NOW);
  eq(active.status, 'active');
  eq(tenantCanSignIn(active), true);
  const { owner } = await claimTenantOwner(
    ctx.db,
    {
      slug: 'initech',
      email: 'peter@initech.test',
      password: 'correct horse battery staple',
      ownerName: 'Peter Gibbons',
    },
    NOW,
  );
  eq(owner.email, 'peter@initech.test');
  const sess = await login(
    ctx.db,
    { tenant: 'initech', email: 'peter@initech.test', password: 'correct horse battery staple' },
    NOW,
  );
  const who = await sessionUser(ctx.db, sess.token, NOW);
  eq(who.user.email, 'peter@initech.test');
});

T('suspended tenant cannot mint or use sessions', async () => {
  const ctx = await fresh();
  await installAuthSchema(ctx.db, NOW);
  await requestTenantRegistration(
    ctx.db,
    { slug: 'hooli', name: 'Hooli', email: 'gavin@hooli.test', ownerName: 'Gavin Belson' },
    NOW,
  );
  await approveTenantRegistration(ctx.db, 'hooli', { userId: 'op_1' }, NOW);
  await setTenantStatus(ctx.db, 'hooli', 'active', { userId: 'op_1' }, NOW);
  await claimTenantOwner(
    ctx.db,
    { slug: 'hooli', email: 'gavin@hooli.test', password: 'correct horse battery staple', ownerName: 'Gavin Belson' },
    NOW,
  );
  const sess = await login(
    ctx.db,
    { tenant: 'hooli', email: 'gavin@hooli.test', password: 'correct horse battery staple' },
    NOW,
  );
  await setTenantStatus(ctx.db, 'hooli', 'suspended', { userId: 'op_1' }, NOW);
  await rejects(
    () => login(ctx.db, { tenant: 'hooli', email: 'gavin@hooli.test', password: 'correct horse battery staple' }, NOW),
    'TENANT_SUSPENDED',
  );
  await rejects(() => sessionUser(ctx.db, sess.token, NOW), 'TENANT_SUSPENDED');
});

T('reject moves to cancelled with reason; approval queue lists pending', async () => {
  const ctx = await fresh();
  await installAuthSchema(ctx.db, NOW);
  await requestTenantRegistration(
    ctx.db,
    { slug: 'umbrella', name: 'Umbrella', email: 'w@umbrella.test', ownerName: 'Wesker' },
    NOW,
  );
  await requestTenantRegistration(
    ctx.db,
    { slug: 'stark', name: 'Stark', email: 'tony@stark.test', ownerName: 'Tony Stark' },
    NOW,
  );
  const pending = await listTenantsByStatus(ctx.db, 'pending_approval');
  eq(pending.length, 2);
  const rejected = await rejectTenantRegistration(ctx.db, 'umbrella', { userId: 'op_1' }, 'sanctions list', NOW);
  eq(rejected.status, 'cancelled');
  const stillPending = await listTenantsByStatus(ctx.db, 'pending_approval');
  eq(stillPending.map((t) => t.slug).join(','), 'stark');
  const avail = await isSlugAvailable(ctx.db, 'umbrella');
  eq(avail.available, false);
});

T('duplicate and reserved registrations are refused uniformly', async () => {
  const ctx = await fresh();
  await installAuthSchema(ctx.db, NOW);
  await requestTenantRegistration(
    ctx.db,
    { slug: 'wayne', name: 'Wayne', email: 'bruce@wayne.test', ownerName: 'Bruce Wayne' },
    NOW,
  );
  await rejects(
    () =>
      requestTenantRegistration(
        ctx.db,
        { slug: 'wayne', name: 'Wayne 2', email: 'al@wayne.test', ownerName: 'Alfred' },
        NOW,
      ),
    'TENANT_EXISTS',
  );
  await rejects(
    () => requestTenantRegistration(ctx.db, { slug: 'app', name: 'App', email: 'a@x.test', ownerName: 'X' }, NOW),
    'SLUG_RESERVED',
  );
  const got = await getTenant(ctx.db, 'wayne');
  eq(got?.requestedByEmail, 'bruce@wayne.test');
});
