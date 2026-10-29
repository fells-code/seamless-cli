export class PermissionError extends Error {
  constructor(
    message = "You do not have permission for this action. It requires an admin role on the instance.",
  ) {
    super(message);
    this.name = "PermissionError";
  }
}
