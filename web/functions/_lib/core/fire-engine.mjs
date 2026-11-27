/**
 * @fileoverview Deterministic Die With Zero & Classic 4% FIRE simulation engine.
 * 100% mathematically aligned with alphalab.site/fire and gas/FireEngine.gs.
 */

export function calcRealReturnRate(nominalReturn, inflationRate) {
  if (!Number.isFinite(nominalReturn) || !Number.isFinite(inflationRate)) {
    throw new Error('nominalReturn and inflationRate must be finite numbers.');
  }
  if (inflationRate <= -1) {
    throw new Error('inflationRate must be greater than -100%.');
  }
  return (1 + nominalReturn) / (1 + inflationRate) - 1;
}

export function annuityPresentValueFactor(r, n) {
  if (n <= 0) return 0;
  if (Math.abs(r) < 1e-9) return n;
  return (1 - Math.pow(1 + r, -n)) / r;
}

export function compoundWorkingCapital(principal, annualSavings, r, m) {
  if (m <= 0) return principal;
  if (Math.abs(r) < 1e-9) return principal + annualSavings * m;
  const growth = Math.pow(1 + r, m);
  return principal * growth + annualSavings * ((growth - 1) / r);
}

export function calcDwzCapitalNeededAtAge(
  startRetireAge,
  lifeExpectancy,
  annualSpending,
  annualPension,
  pensionStartAge,
  realReturn
) {
  const years = Math.max(0, Math.round(lifeExpectancy - startRetireAge));
  if (years === 0) return { dwzTarget: 0, pensionPv: 0 };
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
  return { dwzTarget, pensionPv };
}

export function normalizeFireInputs(raw) {
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
    status,
    currentAge,
    retireAge: effectiveRetireAge,
    lifeExpectancy,
    currentNetWorth,
    monthlySavings,
    monthlySpending,
    monthlyPension,
    pensionStartAge,
    nominalReturn,
    inflationRate,
    classicFireSwr,
  };
}

export function runFireSimulation(rawInputs) {
  const p = normalizeFireInputs(rawInputs);
  const realReturn = calcRealReturnRate(p.nominalReturn, p.inflationRate);
  const annualSavings = p.monthlySavings * 12;
  const annualSpending = p.monthlySpending * 12;
  const annualPension = p.monthlyPension * 12;

  const workingYears = Math.max(0, p.retireAge - p.currentAge);
  const retirementYears = Math.max(0, p.lifeExpectancy - p.retireAge);

  const projectedAtRetire = compoundWorkingCapital(p.currentNetWorth, annualSavings, realReturn, workingYears);
  const atRetireCalc = calcDwzCapitalNeededAtAge(p.retireAge, p.lifeExpectancy, annualSpending, annualPension, p.pensionStartAge, realReturn);
  const todayCalc = calcDwzCapitalNeededAtAge(p.currentAge, p.lifeExpectancy, annualSpending, annualPension, p.pensionStartAge, realReturn);
  const classicFireTarget = annualSpending / p.classicFireSwr;

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
      age, p.lifeExpectancy, annualSpending, annualPension, p.pensionStartAge, realReturn
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
        endIdeal = startIdeal * (1 + realReturn) - (maxAnnualSpending - pension);
      }
      if (depletionAge === null && endReal < -1e-2) {
        depletionAge = age + 1;
      }
    }

    const inflationMultiplier = Math.pow(1 + p.inflationRate, yr);
    trajectory.push({
      yearIndex: yr,
      age,
      phase,
      startRealBalance: startReal,
      realInvestmentGain: realGain,
      netAnnualCashFlow: cashFlow,
      endRealBalance: isTerminal ? startReal : endReal,
      idealDwzBalance: isTerminal ? (Math.abs(startIdeal) < 1e-4 ? 0 : startIdeal) : endIdeal,
      dwzTargetAtAge: dwzNeededThisAge,
      classicFireTarget,
      continuousWorkBalance,
      nominalBalance: (isTerminal ? startReal : endReal) * inflationMultiplier,
    });

    if (!isTerminal) {
      realBalance = endReal;
      idealBalance = endIdeal;
      continuousWorkBalance = continuousWorkBalance * (1 + realReturn) + annualSavings;
    }
  }

  const endingRealBalance = trajectory[trajectory.length - 1]?.endRealBalance ?? p.currentNetWorth;
  const yearsEarlierThanFire =
    earliestDwzRetireAge !== null && earliestClassicFireAge !== null
      ? earliestClassicFireAge - earliestDwzRetireAge
      : null;

  let diagnosisCode = 'SURPLUS';
  let diagnosisText = '';
  if (depletionAge !== null) {
    diagnosisCode = 'DEPLETED';
    diagnosisText = `⚠️ 資金將於 ${depletionAge} 歲耗盡，建議增加儲蓄、降低開銷或延後退休。`;
  } else if (Math.abs(endingRealBalance) <= Math.max(10000, annualSpending * 0.1)) {
    diagnosisCode = 'OPTIMAL_DWZ';
    diagnosisText = '🎯 完美達成 Die With Zero 死前財產歸零目標！';
  } else {
    diagnosisCode = 'SURPLUS';
    diagnosisText = `💰 資產充裕：預計於 ${p.lifeExpectancy} 歲留下約 ${Math.round(endingRealBalance).toLocaleString('en-US')} 元（今日幣值），可考慮提早退休或一鍵套用最高可花月開銷。`;
  }

  return {
    inputs: p,
    realReturnRate: realReturn,
    workingYears,
    retirementYears,
    projectedAtRetire,
    dwzTargetAtRetireAge: atRetireCalc.dwzTarget,
    dwzTargetToday: todayCalc.dwzTarget,
    classicFireTarget,
    maxAnnualSpending,
    maxMonthlySpending,
    endingRealBalance,
    depletionAge,
    earliestDwzRetireAge,
    earliestClassicFireAge,
    yearsEarlierThanFire,
    diagnosisCode,
    diagnosisText,
    trajectory,
  };
}

export function calcCapmReferenceReturn(portfolioBeta, riskFreeRate = 0.015, equityRiskPremium = 0.055) {
  const rf = Number.isFinite(riskFreeRate) ? riskFreeRate : 0.015;
  const erp = Number.isFinite(equityRiskPremium) ? equityRiskPremium : 0.055;
  const beta = Number.isFinite(portfolioBeta) ? portfolioBeta : 1;
  return rf + beta * erp;
}
