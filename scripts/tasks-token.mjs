import { SignJWT } from 'jose';

const secret = process.env.DEV_API_TOKEN;
if (!secret) throw new Error('Load .env.module05-lab with node --env-file');
console.log(await new SignJWT({
  tenant_id: '11111111-1111-4111-8111-111111111111',
  scope: 'query mutation subscribe',
})
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject('55555555-5555-4555-8555-555555555555')
  .setIssuer('urn:reactivecore:lab')
  .setAudience('tasks:lab')
  .setIssuedAt()
  .setExpirationTime('30m')
  .sign(new TextEncoder().encode(secret)));
