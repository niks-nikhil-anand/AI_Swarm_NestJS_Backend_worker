const response = await fetch('http://127.0.0.1:' + (process.env.PORT || '3001') + '/health', {
  signal: AbortSignal.timeout(4000),
});
if (!response.ok) process.exit(1);
const health = await response.json();
if (health.status !== 'ready') process.exit(1);
