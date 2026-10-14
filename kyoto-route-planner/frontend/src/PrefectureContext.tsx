import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

export const PREFECTURES = [
  { code: "01", name: "北海道" },
  { code: "02", name: "青森県" },
  { code: "03", name: "岩手県" },
  { code: "04", name: "宮城県" },
  { code: "05", name: "秋田県" },
  { code: "06", name: "山形県" },
  { code: "07", name: "福島県" },
  { code: "08", name: "茨城県" },
  { code: "09", name: "栃木県" },
  { code: "10", name: "群馬県" },
  { code: "11", name: "埼玉県" },
  { code: "12", name: "千葉県" },
  { code: "13", name: "東京都" },
  { code: "14", name: "神奈川県" },
  { code: "15", name: "新潟県" },
  { code: "16", name: "富山県" },
  { code: "17", name: "石川県" },
  { code: "18", name: "福井県" },
  { code: "19", name: "山梨県" },
  { code: "20", name: "長野県" },
  { code: "21", name: "岐阜県" },
  { code: "22", name: "静岡県" },
  { code: "23", name: "愛知県" },
  { code: "24", name: "三重県" },
  { code: "25", name: "滋賀県" },
  { code: "26", name: "京都府" },
  { code: "27", name: "大阪府" },
  { code: "28", name: "兵庫県" },
  { code: "29", name: "奈良県" },
  { code: "30", name: "和歌山県" },
  { code: "31", name: "鳥取県" },
  { code: "32", name: "島根県" },
  { code: "33", name: "岡山県" },
  { code: "34", name: "広島県" },
  { code: "35", name: "山口県" },
  { code: "36", name: "徳島県" },
  { code: "37", name: "香川県" },
  { code: "38", name: "愛媛県" },
  { code: "39", name: "高知県" },
  { code: "40", name: "福岡県" },
  { code: "41", name: "佐賀県" },
  { code: "42", name: "長崎県" },
  { code: "43", name: "熊本県" },
  { code: "44", name: "大分県" },
  { code: "45", name: "宮崎県" },
  { code: "46", name: "鹿児島県" },
  { code: "47", name: "沖縄県" },
] as const;

export type PrefectureCode = (typeof PREFECTURES)[number]["code"];
export type Prefecture = (typeof PREFECTURES)[number];

export const PREFECTURE_REGIONS = [
  { name: "北海道", codes: ["01"] },
  { name: "東北", codes: ["02", "03", "04", "05", "06", "07"] },
  { name: "関東", codes: ["08", "09", "10", "11", "12", "13", "14"] },
  { name: "北陸", codes: ["15", "16", "17", "18"] },
  { name: "甲信", codes: ["19", "20"] },
  { name: "東海", codes: ["21", "22", "23", "24"] },
  { name: "近畿", codes: ["25", "26", "27", "28", "29", "30"] },
  { name: "中国", codes: ["31", "32", "33", "34", "35"] },
  { name: "四国", codes: ["36", "37", "38", "39"] },
  { name: "九州", codes: ["40", "41", "42", "43", "44", "45", "46"] },
  { name: "沖縄", codes: ["47"] },
] satisfies { name: string; codes: PrefectureCode[] }[];

type PrefectureContextValue = {
  prefecture: Prefecture;
  setPrefectureCode: (code: PrefectureCode) => void;
};

const KYOTO = PREFECTURES[25];
const PrefectureContext = createContext<PrefectureContextValue | null>(null);

type PrefectureProviderProps = {
  children: ReactNode;
};

export function PrefectureProvider({ children }: PrefectureProviderProps) {
  const [prefecture, setPrefecture] = useState<Prefecture>(KYOTO);
  const value = useMemo(() => ({
    prefecture,
    setPrefectureCode: (code: PrefectureCode) => {
      const nextPrefecture = PREFECTURES.find((candidate) => candidate.code === code);
      if (!nextPrefecture) throw new RangeError(`Unknown prefecture code: ${code}`);
      setPrefecture(nextPrefecture);
    },
  }), [prefecture]);

  return <PrefectureContext.Provider value={value}>{children}</PrefectureContext.Provider>;
}

export function usePrefecture() {
  const context = useContext(PrefectureContext);
  if (!context) throw new Error("usePrefecture must be used within PrefectureProvider.");
  return context;
}
