import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Field } from "@/components/ui";

type FieldProps = Parameters<typeof Field>[0];

describe("Field labels its control (#157)", () => {
  it("ties the label to the first control, also when something sits beside it", () => {
    const html = renderToStaticMarkup(
      createElement(Field, { label: "Customer", hint: "Who it's for." } as FieldProps, createElement("select", { name: "contact" }), createElement("span", null, "Export")),
    );
    const labelFor = /<label for="([^"]+)"/.exec(html)?.[1];
    expect(labelFor).toBeTruthy();
    expect(html).toContain(`<select name="contact" id="${labelFor}" aria-describedby="${labelFor}-hint">`);
    expect(html).toContain("<span>Export</span>");
  });

  it("still works with a single control", () => {
    const html = renderToStaticMarkup(createElement(Field, { label: "Name" } as FieldProps, createElement("input", { id: "own" })));
    expect(html).toContain('<label for="own"');
    expect(html).toContain('<input id="own"/>');
  });
});
