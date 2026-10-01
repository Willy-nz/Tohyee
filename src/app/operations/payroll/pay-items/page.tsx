"use client";

import { RequireOrganisation } from "@/components/books";
import { PayrollAccessGate } from "@/components/payroll-access";
import { PayrollPayItems } from "@/components/payroll-pay-items";
import { PaydayFilingSettingsCard } from "@/components/payroll-payday-filing";
import { Page, PageHeader } from "@/components/ui";
import styles from "@/components/payroll-employees.module.css";

export default function PayrollPayItemsPage() {
  return (
    <Page>
      <PageHeader title="Pay items" description="The earnings, deductions and employer contributions pay runs are made of, where each is posted, and payroll settings." />
      <RequireOrganisation>
        {(organisationId) => (
          <PayrollAccessGate key={organisationId} organisationId={organisationId}>
            <div className={styles.stack}>
              <PayrollPayItems organisationId={organisationId} />
              <PaydayFilingSettingsCard organisationId={organisationId} />
            </div>
          </PayrollAccessGate>
        )}
      </RequireOrganisation>
    </Page>
  );
}
