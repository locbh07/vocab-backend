import app from './app';

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('uncaughtException:', error);
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`vocab-backend listening on ${port}`);
});
