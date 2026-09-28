import { redirect } from "next/navigation";

export default function ServerHome() {
  redirect("/server/organisations");
}
