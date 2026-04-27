import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export default function HomePage() {
  const token = cookies().get("flowpro_token")?.value;
  redirect(token ? "/workspace" : "/login");
}

