/** Shared by the story repository and its native document parser. */
export const newId = () => crypto.randomUUID().replace(/-/g, "");
