/** Does nothing. Deploying or deleting it is the trigger. */
export default { fetch() { return new Response("trigger dummy"); } };
