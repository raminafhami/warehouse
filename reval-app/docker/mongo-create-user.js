const application = db.getSiblingDB(process.env.MONGO_INITDB_DATABASE);
application.createUser({
  user: "reval_app",
  pwd: process.env.REVAL_DB_PASSWORD,
  roles: [{ role: "readWrite", db: application.getName() }],
});
