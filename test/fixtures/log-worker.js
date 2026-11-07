process.send?.({ type: 'ready' });
console.error('Fixture worker error: diagnostic line survives worker restart.');
process.on('disconnect', () => process.exit(0));
setInterval(() => {}, 1000);
