const hello = db.hello();
if (hello.isreplicaset) {
  try {
    rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "mongo:27017" }] });
  } catch (error) {
    if (error.codeName !== "AlreadyInitialized") throw error;
  }
}
quit(hello.setName === "rs0" && hello.isWritablePrimary ? 0 : 1);
