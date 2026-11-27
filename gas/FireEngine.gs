/**
 * @fileoverview Deterministic Die With Zero & Classic 4% FIRE calculation engine.
 * Strictly aligned with alphalab.site/fire design:
 *  - Working vs Already Retired status
 *  - Fisher real return rate (all outputs in today's purchasing power)
 *  - Die With Zero target capital (at target retirement age & retiring today)
 *  - Reverse-solved Max Monthly Spending to hit exact zero at life expectancy
 *  - Earliest Retirement Age comparison: Die With Zero vs Classic 4% FIRE
 *  - Full year-by-year real & nominal trajectory
 *  - Portfolio Beta stress testing & CAPM reference return
 */

/**
 * Computes Fisher real annual return rate: (1 + nominal) / (1 + inflation) - 1.
 * @param {number} nominalReturn
 * @param {number} inflationRate
 * @return {number}
 */
function calcRealReturnRate(nominalReturn, inflationRate) {
  if (!Number.isFinite(nominalReturn) || !Number.isFinite(inflationRate)) {
    throw new Error('nominalReturn and inflationRate must be finite numbers.');
  }
  if (inflationRate <= -1) {
    throw new Error('inflationRate must be greater than -100%.');
  }
  return (1 + nominalReturn) / (1 + inflationRate) - 1;
}

/**
 * Computes present value factor of an ordinary annuity of 1/year for n years at rate r.
 * Handles r = 0 and negative r safely without division by zero.
 * @param {number} r Annual real rate
 * @param {number} n Number of years
 * @return {number}
 */
function annuityPresentValueFactor(r, n) {
  if (n <= 0) {
    return 0;
  }
  if (Math.abs(r) < 1e-9) {
    return n;
  }
  return (1 - Math.pow(1 + r, -n)) / r;
}

/**
 * Computes future value of initial capital + annual end-of-year savings over m years.
 * Matches discrete recursion: W_{t+1} = W_t * (1 + r) + annualSavings.
 * @param {number} principal
 * @param {number} annualSavings
 * @param {number} r
 * @param {number} m
 * @return {number}
 */
function compoundWorkingCapital(principal, annualSavings, r, m) {
  if (m <= 0) {
    return principal;
  }
  if (Math.abs(r) < 1e-9) {
    return principal + annualSavings * m;
  }
  const growth = Math.pow(1 + r, m);
  return principal * growth + annualSavings * ((growth - 1) / r);
}

/**
 * Computes the present value at `startRetireAge` of net retirement outflows (spending - pension)
 * required to fund years [startRetireAge, lifeExpectancy - 1] and end at exact 0 at lifeExpectancy.
 * @param {number} startRetireAge
 * @param {number} lifeExpectancy
 * @param {number} annualSpending
 * @param {number} annualPension
 * @param {number} pensionStartAge
 * @param {number} realReturn
 * @return {{dwzTarget: number, pensionPv: number}}
 */
function calcDwzCapitalNeededAtAge(
  startRetireAge,
  lifeExpectancy,
  annualSpending,
  annualPension,
  pensionStartAge,
  realReturn
) {
  const years = Math.max(0, Math.round(lifeExpectancy - startRetireAge));
  if (years === 0) {
    return { dwzTarget: 0, pensionPv: 0 };
  }
  let dwzTarget = 0;
  let pensionPv = 0;
  for (let k = 1; k <= years; k++) {
    const age = startRetireAge + k - 1;
    const pension = age >= pensionStartAge ? annualPension : 0;
    const netOutflow = Math.max(0, annualSpending - pension);
    const discount = Math.pow(1 + realReturn, k);
    dwzTarget += netOutflow / discount;
    pensionPv += Math.min(annualSpending, pension) / discount;
  }
  return { dwzTarget: dwzTarget, pensionPv: pensionPv };
}

/**
 * Validates and normalizes FireEngine input parameters.
 * @param {Object} raw
 * @return {Object}
 */
function normalizeFireInputs(raw) {
  const input = raw || {};
  const status = input.status === '已經退休' ? '已經退休' : '還在工作';
  const currentAge = Math.round(Number(input.currentAge));
  const rawRetireAge = Math.round(Number(input.retireAge));
  const lifeExpectancy = Math.round(Number(input.lifeExpectancy));
  const currentNetWorth = Number(input.currentNetWorth);
  const monthlySavings = status === '已經退休' ? 0 : Math.max(0, Number(input.monthlySavings || 0));
  const monthlySpending = Math.max(0, Number(input.monthlySpending || 0));
  const monthlyPension = Math.max(0, Number(input.monthlyPension || 0));
  const pensionStartAge = Number.isFinite(Number(input.pensionStartAge))
    ? Math.round(Number(input.pensionStartAge))
    : 65;
  const nominalReturn = Number(input.nominalReturn);
  const inflationRate = Number(input.inflationRate);
  const classicFireSwr = Number.isFinite(Number(input.classicFireSwr)) && Number(input.classicFireSwr) > 0
    ? Number(input.classicFireSwr)
    : 0.04;

  if (!Number.isFinite(currentAge) || currentAge < 15 || currentAge > 110) {
    throw new Error('currentAge must be between 15 and 110.');
  }
  if (!Number.isFinite(lifeExpectancy) || lifeExpectancy <= currentAge || lifeExpectancy > 120) {
    throw new Error('lifeExpectancy must be greater than currentAge and <= 120.');
  }
  const effectiveRetireAge = status === '已經退休'
    ? currentAge
    : Math.min(lifeExpectancy, Math.max(currentAge, Number.isFinite(rawRetireAge) ? rawRetireAge : currentAge));
  if (!Number.isFinite(currentNetWorth)) {
    throw new Error('currentNetWorth must be a finite number.');
  }
  if (!Number.isFinite(nominalReturn) || nominalReturn < -0.5 || nominalReturn > 0.5) {
    throw new Error('nominalReturn must be between -50% and +50%.');
  }
  if (!Number.isFinite(inflationRate) || inflationRate < -0.1 || inflationRate > 0.3) {
    throw new Error('inflationRate must be between -10% and +30%.');
  }

  return {
    status: status,
    currentAge: currentAge,
    retireAge: effectiveRetireAge,
    lifeExpectancy: lifeExpectancy,
    currentNetWorth: currentNetWorth,
    monthlySavings: monthlySavings,
    monthlySpending: monthlySpending,
    monthlyPension: monthlyPension,
    pensionStartAge: pensionStartAge,
    nominalReturn: nominalReturn,
    inflationRate: inflationRate,
    classicFireSwr: classicFireSwr,
  };
}

/**
 * Runs complete Die With Zero & Classic 4% FIRE simulation.
 * @param {Object} rawInputs
 * @return {Object} Full KPI summary + year-by-year trajectory array
 */
function runFireSimulation(rawInputs) {
  const p = normalizeFireInputs(rawInputs);
  const realReturn = calcRealReturnRate(p.nominalReturn, p.inflationRate);
  const annualSavings = p.monthlySavings * 12;
  const annualSpending = p.monthlySpending * 12;
  const annualPension = p.monthlyPension * 12;

  const workingYears = Math.max(0, p.retireAge - p.currentAge);
  const retirementYears = Math.max(0, p.lifeExpectancy - p.retireAge);

  // Wealth projected at chosen retirement age (in today's purchasing power)
  const projectedAtRetire = compoundWorkingCapital(
    p.currentNetWorth,
    annualSavings,
    realReturn,
    workingYears
  );

  // DWZ targets
  const atRetireCalc = calcDwzCapitalNeededAtAge(
    p.retireAge,
    p.lifeExpectancy,
    annualSpending,
    annualPension,
    p.pensionStartAge,
    realReturn
  );
  const todayCalc = calcDwzCapitalNeededAtAge(
    p.currentAge,
    p.lifeExpectancy,
    annualSpending,
    annualPension,
    p.pensionStartAge,
    realReturn
  );

  // Classic 4% FIRE target (pure spending / SWR)
  const classicFireTarget = annualSpending / p.classicFireSwr;

  // Reverse-solve Max Monthly Spending so ending balance at lifeExpectancy is EXACTLY 0
  // Equation: projectedAtRetire + PV(pension capped or full) = C_max * A(r, N)
  // Note: If pension > 0, check full pension PV (since C_max >= pension in normal cases).
  let maxAnnualSpending = 0;
  if (retirementYears > 0) {
    let fullPensionPv = 0;
    for (let k = 1; k <= retirementYears; k++) {
      const age = p.retireAge + k - 1;
      const pen = age >= p.pensionStartAge ? annualPension : 0;
      fullPensionPv += pen / Math.pow(1 + realReturn, k);
    }
    const pvFactor = annuityPresentValueFactor(realReturn, retirementYears);
    maxAnnualSpending = pvFactor > 0 ? Math.max(0, (projectedAtRetire + fullPensionPv) / pvFactor) : 0;
  }
  const maxMonthlySpending = maxAnnualSpending / 12;

  // Year-by-year trajectory & earliest retirement age search
  const trajectory = [];
  let realBalance = p.currentNetWorth;
  let idealBalance = p.currentNetWorth;
  let continuousWorkBalance = p.currentNetWorth;
  let depletionAge = null;
  let earliestDwzRetireAge = null;
  let earliestClassicFireAge = null;

  const totalYears = p.lifeExpectancy - p.currentAge;
  for (let yr = 0; yr <= totalYears; yr++) {
    const age = p.currentAge + yr;
    const isTerminal = age === p.lifeExpectancy;
    const isWorking = !isTerminal && age < p.retireAge;
    const phase = isTerminal ? '預期壽命終點' : (isWorking ? '工作累積期' : '退休提領期');

    const dwzNeededThisAge = calcDwzCapitalNeededAtAge(
      age,
      p.lifeExpectancy,
      annualSpending,
      annualPension,
      p.pensionStartAge,
      realReturn
    ).dwzTarget;

    if (earliestDwzRetireAge === null && continuousWorkBalance >= dwzNeededThisAge - 1e-6) {
      earliestDwzRetireAge = age;
    }
    if (earliestClassicFireAge === null && continuousWorkBalance >= classicFireTarget - 1e-6) {
      earliestClassicFireAge = age;
    }

    const startReal = realBalance;
    const startIdeal = idealBalance;
    let realGain = 0;
    let cashFlow = 0;
    let endReal = startReal;
    let endIdeal = startIdeal;

    if (!isTerminal) {
      realGain = startReal * realReturn;
      if (isWorking) {
        cashFlow = annualSavings;
        endReal = startReal + realGain + cashFlow;
        endIdeal = startIdeal * (1 + realReturn) + annualSavings;
      } else {
        const pension = age >= p.pensionStartAge ? annualPension : 0;
        cashFlow = -(annualSpending - pension);
        endReal = startReal + realGain + cashFlow;

        const idealCashFlow = -(maxAnnualSpending - pension);
        endIdeal = startIdeal * (1 + realReturn) + idealCashFlow;
      }
      if (depletionAge === null && endReal < -1e-2) {
        depletionAge = age + 1;
      }
    }

    const inflationMultiplier = Math.pow(1 + p.inflationRate, yr);
    trajectory.push({
      yearIndex: yr,
      age: age,
      phase: phase,
      startRealBalance: startReal,
      realInvestmentGain: realGain,
      netAnnualCashFlow: cashFlow,
      endRealBalance: isTerminal ? startReal : endReal,
      idealDwzBalance: isTerminal ? Math.abs(startIdeal) < 1e-4 ? 0 : startIdeal : endIdeal,
      dwzTargetAtAge: dwzNeededThisAge,
      classicFireTarget: classicFireTarget,
      continuousWorkBalance: continuousWorkBalance,
      nominalBalance: (isTerminal ? startReal : endReal) * inflationMultiplier,
    });

    if (!isTerminal) {
      realBalance = endReal;
      idealBalance = endIdeal;
      continuousWorkBalance = continuousWorkBalance * (1 + realReturn) + annualSavings;
    }
  }

  const terminalRow = trajectory[trajectory.length - 1];
  const endingRealBalance = terminalRow ? terminalRow.endRealBalance : p.currentNetWorth;
  const yearsEarlierThanFire =
    earliestDwzRetireAge !== null && earliestClassicFireAge !== null
      ? earliestClassicFireAge - earliestDwzRetireAge
      : null;

  let diagnosisCode = 'SURPLUS';
  let diagnosisText = '';
  if (depletionAge !== null) {
    diagnosisCode = 'DEPLETED';
    diagnosisText = '⚠️ 資金將於 ' + depletionAge + ' 歲耗盡，建議增加儲蓄、調整開銷或延後退休。';
  } else if (Math.abs(endingRealBalance) <= Math.max(10000, annualSpending * 0.1)) {
    diagnosisCode = 'OPTIMAL_DWZ';
    diagnosisText = '🎯 完美達成 Die With Zero 死前財產歸零目標！';
  } else {
    diagnosisCode = 'SURPLUS';
    diagnosisText = '💰 資產充裕：預計於 ' + p.lifeExpectancy + ' 歲留下約 ' + Math.round(endingRealBalance).toLocaleString('en-US') + ' 元（今日幣值），可考慮提早退休或套用最高可花月開銷。';
  }

  return {
    inputs: p,
    realReturnRate: realReturn,
    workingYears: workingYears,
    retirementYears: retirementYears,
    projectedAtRetire: projectedAtRetire,
    dwzTargetAtRetireAge: atRetireCalc.dwzTarget,
    dwzTargetToday: todayCalc.dwzTarget,
    classicFireTarget: classicFireTarget,
    maxAnnualSpending: maxAnnualSpending,
    maxMonthlySpending: maxMonthlySpending,
    endingRealBalance: endingRealBalance,
    depletionAge: depletionAge,
    earliestDwzRetireAge: earliestDwzRetireAge,
    earliestClassicFireAge: earliestClassicFireAge,
    yearsEarlierThanFire: yearsEarlierThanFire,
    diagnosisCode: diagnosisCode,
    diagnosisText: diagnosisText,
    trajectory: trajectory,
  };
}

/**
 * Estimates CAPM reference nominal return given portfolio Beta.
 * Strictly informational (past Beta/returns do not guarantee future returns).
 * @param {number} portfolioBeta
 * @param {number} riskFreeRate
 * @param {number} equityRiskPremium
 * @return {number}
 */
function calcCapmReferenceReturn(portfolioBeta, riskFreeRate, equityRiskPremium) {
  const rf = Number.isFinite(riskFreeRate) ? riskFreeRate : 0.015;
  const erp = Number.isFinite(equityRiskPremium) ? equityRiskPremium : 0.055;
  const beta = Number.isFinite(portfolioBeta) ? portfolioBeta : 1;
  return rf + beta * erp;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    calcRealReturnRate,
    annuityPresentValueFactor,
    compoundWorkingCapital,
    calcDwzCapitalNeededAtAge,
    normalizeFireInputs,
    runFireSimulation,
    calcCapmReferenceReturn,
  };
}
