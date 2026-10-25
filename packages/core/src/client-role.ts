/** The two roles scoped to one workspace (everyone else belongs to the whole organization). */
export const isClientRole = (role: string) => role === "client_approver" || role === "client_viewer";
