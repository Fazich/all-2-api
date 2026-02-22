#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
合并所有 邮箱.json 文件到一个总文件 all_tokens.json
"""

import json
import glob
import os
import re

def merge_token_files():
    # 获取当前目录
    current_dir = os.path.dirname(os.path.abspath(__file__))

    # 匹配所有 *.json 文件
    pattern = os.path.join(current_dir, "*.json")
    all_files = glob.glob(pattern)

    # 过滤出邮箱格式的文件 (xxx@xxx.xxx.json)
    email_pattern = re.compile(r'^[^@]+@[^@]+\.[^@]+\.json$')
    files = [f for f in all_files if email_pattern.match(os.path.basename(f))]

    # 存储所有数据的数组
    all_tokens = []

    print(f"找到 {len(files)} 个邮箱 token 文件:")

    for file_path in sorted(files):
        filename = os.path.basename(file_path)
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                data = json.load(f)

            # 如果是数组，扩展；如果是对象，追加
            if isinstance(data, list):
                all_tokens.extend(data)
                print(f"  {filename}: 添加 {len(data)} 条记录")
            else:
                all_tokens.append(data)
                print(f"  {filename}: 添加 1 条记录")

        except Exception as e:
            print(f"  {filename}: 读取失败 - {e}")

    # 写入总文件
    output_file = os.path.join(current_dir, "all_tokens.json")
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(all_tokens, f, ensure_ascii=False, indent=2)

    print(f"\n合并完成! 共 {len(all_tokens)} 条记录")
    print(f"输出文件: {output_file}")

if __name__ == "__main__":
    merge_token_files()
