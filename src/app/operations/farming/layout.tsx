import { FarmFrame } from "@/components/farm-frame";

/** Every farm page shares the Farm tabs (#498 item 2, decision 1111), so they're there on a direct link, a reload and offline. */
export default function FarmLayout({ children }: LayoutProps<"/operations/farming">) {
  return <FarmFrame>{children}</FarmFrame>;
}
